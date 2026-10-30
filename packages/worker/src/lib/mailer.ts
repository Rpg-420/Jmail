import { DatabaseQueries, Email } from '../db/queries';
import { loadAttachmentBase64 } from './attachments';
import { generateId } from './utils';
import { sendThroughProviders } from './providers';
import {
  PermanentSendError,
  QuotaExhaustedError,
  type OutboundMessage,
  type ProviderId,
  type Recipient,
} from './providers/types';
import { emitMailEvent } from './webhooks-out';
import { DRAIN_LEASE_SECONDS, MAX_SEND_ATTEMPTS, retryAt, sendRetryDelayMs, utcDay } from './backoff';

/**
 * Delivery path shared by the web UI, the mail-server API, and the cron
 * drain. Anything the caller submits ends up as a queued `emails` row, so
 * quota exhaustion is a retry condition rather than lost mail.
 */

export const SEND_MAX_ATTEMPTS = MAX_SEND_ATTEMPTS;

export interface DeliveryOutcome {
  providerMessageId: string;
  provider: ProviderId;
}

export function parseEmailAddress(email: string): Recipient {
  const match = email.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  }
  return { email: email.trim() };
}

/** "a@x.com, Bob <b@y.com>" → two recipients. The old single-address path
 *  silently sent a comma-joined string to the relay. */
export function parseAddressList(value: string | null | undefined): Recipient[] {
  if (!value) return [];
  return value
    .split(/,(?![^<]*>)/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(parseEmailAddress)
    .filter(recipient => !!recipient.email);
}

export function sendRetryDeadline(attempts: number): string {
  return retryAt(sendRetryDelayMs(attempts));
}

/**
 * People you write to become contacts automatically. Never fatal.
 */
export async function recordRecipientsAsContacts(db: DatabaseQueries, email: Email): Promise<void> {
  try {
    const recipients = [
      ...parseAddressList(email.to_address),
      ...parseAddressList(email.cc),
      ...parseAddressList(email.bcc),
    ];

    for (const recipient of recipients) {
      if (!recipient.email.includes('@')) continue;
      await db.upsertContact({
        id: generateId(),
        email: recipient.email,
        name: recipient.name ?? null,
      });
      await db.touchContactLastContacted(recipient.email);
    }
  } catch (error) {
    console.warn('Contact auto-capture failed:', error);
  }
}

async function buildOutboundMessage(
  db: DatabaseQueries,
  bucket: R2Bucket | undefined,
  email: Email
): Promise<OutboundMessage> {
  const to = parseAddressList(email.to_address);
  if (to.length === 0) {
    throw new PermanentSendError(`No usable recipient in "${email.to_address}"`, 'brevo');
  }

  const attachments: OutboundMessage['attachments'] = [];
  const rows = await db.getAttachmentsByEmailId(email.id);
  for (const row of rows) {
    const full = await db.getAttachment(row.id);
    if (!full) continue;
    const content = await loadAttachmentBase64(bucket, full);
    if (content) {
      attachments.push({ filename: full.filename, content, contentType: full.content_type });
    }
  }

  // Threading headers for replies
  const headers: Record<string, string> = {};
  if (email.in_reply_to) {
    headers['In-Reply-To'] = email.in_reply_to;
    headers['References'] = email.in_reply_to;
  }

  const fromList = parseAddressList(email.from_address);

  return {
    from: fromList[0] ?? { email: email.from_address },
    to,
    cc: parseAddressList(email.cc),
    bcc: parseAddressList(email.bcc),
    subject: email.subject || '(No Subject)',
    text: email.body_text || undefined,
    html: email.body_html || undefined,
    attachments,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    tags: email.token_id ? { token: email.token_id, jmail: 'api' } : { jmail: 'ui' },
  };
}

/**
 * Hand one stored email to the first provider with quota. Throws
 * QuotaExhaustedError / TransientSendError (retry) or PermanentSendError (die).
 */
export async function deliverStoredEmail(
  db: DatabaseQueries,
  bucket: R2Bucket | undefined,
  email: Email
): Promise<DeliveryOutcome> {
  const message = await buildOutboundMessage(db, bucket, email);
  const outcome = await sendThroughProviders(db, message);
  return { providerMessageId: outcome.providerMessageId, provider: outcome.provider };
}

export interface QueueReport {
  sent: number;
  retried: number;
  failed: number;
  /** Rows another drain already owns; they stay queued for the next tick. */
  skipped: number;
}

/**
 * Drain due queue rows. A single relay outage or a day of exhausted quota
 * must not lose mail, so failures keep the row and only the attempt counter
 * moves — until the ladder is spent or the relay calls it permanent.
 */
export async function processEmailQueue(
  db: DatabaseQueries,
  bucket: R2Bucket | undefined,
  limit = 20
): Promise<QueueReport> {
  const report: QueueReport = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  const due = await db.listDueQueueEmails(limit);

  for (const email of due) {
    // Cron ticks can overlap (a slow relay, a retried trigger). Whoever fails
    // the claim is not this message's sender.
    if (!(await db.claimQueueEmail(email.id, DRAIN_LEASE_SECONDS))) {
      report.skipped++;
      continue;
    }

    const attempts = (email.attempts ?? 0) + 1;

    try {
      const outcome = await deliverStoredEmail(db, bucket, email);
      await db.markEmailSent(email.id, outcome.providerMessageId, outcome.provider);
      await recordRecipientsAsContacts(db, email);
      if (email.token_id) await db.recordTokenUsage(email.token_id, utcDay(), 'sent');
      report.sent++;
      await emitMailEvent(db, 'sent', {
        id: email.id,
        to: email.to_address,
        subject: email.subject,
        provider: outcome.provider,
        provider_message_id: outcome.providerMessageId,
        token_id: email.token_id,
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';

      if (error instanceof QuotaExhaustedError) {
        // Nothing wrong with the message: keep it queued, retry on the ladder.
        await db.updateEmailQueueFields(email.id, {
          delivery_status: 'deferred',
          attempts,
          next_attempt_at: sendRetryDeadline(attempts),
          last_error: details.slice(0, 500),
          provider: null,
        });
        report.retried++;
        continue;
      }

      if (error instanceof PermanentSendError || attempts >= MAX_SEND_ATTEMPTS) {
        await db.updateEmailQueueFields(email.id, {
          delivery_status: 'failed',
          attempts,
          next_attempt_at: null,
          last_error: details.slice(0, 500),
          provider: null,
        });
        if (email.token_id) await db.recordTokenUsage(email.token_id, utcDay(), 'failed');
        report.failed++;
        await emitMailEvent(db, 'failed', {
          id: email.id,
          to: email.to_address,
          subject: email.subject,
          error: details.slice(0, 300),
          attempts,
          token_id: email.token_id,
        });
        continue;
      }

      await db.updateEmailQueueFields(email.id, {
        delivery_status: 'deferred',
        attempts,
        next_attempt_at: sendRetryDeadline(attempts),
        last_error: details.slice(0, 500),
        provider: null,
      });
      report.retried++;
    }
  }

  return report;
}
