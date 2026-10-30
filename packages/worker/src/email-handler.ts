import PostalMime from 'postal-mime';
import { DatabaseQueries } from './db/queries';
import { storeAttachment, maxAttachmentSize } from './lib/attachments';
import { notifyAllSubscriptions } from './lib/push';
import { notifyTelegram } from './lib/telegram';
import { emitMailEvent } from './lib/webhooks-out';

export interface Env {
  DB: D1Database;
  ATTACHMENTS?: R2Bucket;
}

/**
 * Storage bounds for a received message. Email Routing already caps the whole
 * message (~5 MiB), but one hostile mail should not be able to eat the 5 GB
 * database or make the inbox unreadable, so each part is clamped on the way in.
 * The numbers mirror what /api/v1/send accepts.
 */
export const MAX_INBOUND_TEXT_BYTES = 1_000_000;
export const MAX_INBOUND_HTML_BYTES = 2_000_000;
export const MAX_INBOUND_SUBJECT_LENGTH = 998;
export const MAX_INBOUND_HEADERS_BYTES = 256_000;
export const MAX_INBOUND_ATTACHMENTS = 25;

/** Keep a stored field inside its limit, reporting whether anything was cut. */
function clampField(value: string | null | undefined, limit: number): { value: string | null; truncated: boolean } {
  if (!value) return { value: null, truncated: false };
  return value.length > limit
    ? { value: `${value.slice(0, limit)}\n\n---\nMessage truncated at the storage limit.`, truncated: true }
    : { value, truncated: false };
}

/**
 * Determine the conversation (thread) id for an incoming message.
 * A reply joins the thread of the message it references; otherwise the
 * message starts a new thread keyed by its own Message-ID (or row id).
 */
async function resolveThreadId(
  db: DatabaseQueries,
  messageId: string | null,
  inReplyTo: string | null,
  references: string[],
  fallbackId: string
): Promise<string> {
  const candidates = [inReplyTo, ...references.slice().reverse()].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    const referenced = await db.getEmailByMessageId(candidate);
    if (referenced?.thread_id) {
      return referenced.thread_id;
    }
  }
  return messageId || fallbackId;
}

/**
 * Handles incoming emails via Cloudflare Email Workers
 * Parses the email, stores it in D1 (attachments in R2), and forwards to destination
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const db = new DatabaseQueries(env.DB);

  const rawEmail = await new Response(message.raw).arrayBuffer();
  const rawEmailUint8 = new Uint8Array(rawEmail);

  // A message this parser cannot read must not be re-delivered forever:
  // re-throwing makes Cloudflare retry a poison message on every retry
  // budget, and the sender never learns. Store it as an undecodable row.
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmailUint8).catch((error: Error) => {
    console.error('Unparseable inbound message:', error.message);
    return null;
  });

  if (!parsed) {
    const id = crypto.randomUUID();
    await db.createEmail({
      id,
      type: 'received',
      from_address: message.from,
      to_address: message.to,
      cc: null,
      bcc: null,
      subject: '(undecodable message)',
      body_text: `This message could not be parsed and was kept for inspection.\n\nSender: ${message.from}\nSize: ${rawEmail.byteLength} bytes`,
      body_html: null,
      headers: null,
      raw_size: rawEmail.byteLength,
      is_read: 0,
      is_starred: 0,
      message_id: null,
      in_reply_to: null,
      thread_id: id,
      provider_message_id: null,
    });
    await forwardToDestination(db, message);
    return;
  }

  try {
    // Generate a unique ID
    const id = crypto.randomUUID();

    // Extract headers as JSON string. Spam with thousands of trace headers is
    // common; keep the ones the UI renders rather than storing a 4 MB blob.
    let headers = JSON.stringify(parsed.headers);
    if (headers.length > MAX_INBOUND_HEADERS_BYTES) {
      const keep = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'reply-to']);
      const trimmed = parsed.headers.filter(header => keep.has(header.key));
      const dropped = parsed.headers.length - trimmed.length;
      trimmed.push({
        key: 'x-jmail-truncated-headers',
        originalKey: 'X-JMail-Truncated-Headers',
        value: `${dropped} headers dropped at the storage limit`,
      });
      headers = JSON.stringify(trimmed);
    }

    const subject = clampField(parsed.subject || '(No Subject)', MAX_INBOUND_SUBJECT_LENGTH).value;
    const textBody = clampField(parsed.text, MAX_INBOUND_TEXT_BYTES);
    const htmlBody = clampField(parsed.html, MAX_INBOUND_HTML_BYTES);

    // Threading
    const messageId = parsed.messageId || null;
    const inReplyTo = parsed.inReplyTo?.trim() || null;
    const references = (parsed.references || '').split(/\s+/).filter(Boolean);
    const threadId = await resolveThreadId(db, messageId, inReplyTo, references, id);

    // Store the email in D1
    await db.createEmail({
      id,
      type: 'received',
      from_address: message.from,
      to_address: message.to,
      cc: parsed.cc?.map(c => c.address).join(', ') || null,
      bcc: null,
      subject,
      body_text: textBody.value,
      body_html: htmlBody.value,
      headers,
      raw_size: rawEmail.byteLength,
      is_read: 0,
      is_starred: 0,
      message_id: messageId,
      in_reply_to: inReplyTo,
      thread_id: threadId,
      provider_message_id: null,
    });

    // Store attachments (R2 when configured, D1 inline otherwise)
    const sizeLimit = maxAttachmentSize(env.ATTACHMENTS);
    let storedAttachments = 0;
    const skippedAttachments: string[] = [];
    if (parsed.attachments && parsed.attachments.length > 0) {
      for (const attachment of parsed.attachments) {
        if (storedAttachments >= MAX_INBOUND_ATTACHMENTS) {
          skippedAttachments.push(`${attachment.filename || 'unnamed'} (over the file count limit)`);
          continue;
        }
        // postal-mime may deliver text attachments as strings
        const data: Uint8Array = typeof attachment.content === 'string'
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content);

        if (data.byteLength > sizeLimit) {
          // Visible in the stored mail instead of silently vanishing: a person
          // reading the message must know the file is missing, not guess.
          skippedAttachments.push(`${attachment.filename || 'unnamed'} (${Math.round(data.byteLength / 1024 / 1024)}MB)`);
          continue;
        }

        await storeAttachment(db, env.ATTACHMENTS, {
          emailId: id,
          filename: attachment.filename || 'unnamed',
          contentType: attachment.mimeType || 'application/octet-stream',
          bytes: data,
        });
        storedAttachments++;
      }
    }

    const notes: string[] = [];
    if (skippedAttachments.length > 0) {
      notes.push(`Attachments too large or too many to store were dropped: ${skippedAttachments.join(', ')}`);
    }
    if (textBody.truncated || htmlBody.truncated) {
      notes.push('The message body was truncated at the storage limit.');
    }

    if (notes.length > 0) {
      const plain = `\n\n---\n${notes.join('\n')}`;
      await db.updateEmailContent(id, {
        from_address: message.from,
        to_address: message.to,
        cc: parsed.cc?.map(c => c.address).join(', ') || null,
        bcc: null,
        subject,
        body_text: `${textBody.value ?? ''}${plain}` as string,
        body_html: htmlBody.value ? `${htmlBody.value}<div><hr>${notes.join('<br>')}</div>` : null,
        scheduled_at: null,
      });
    }

    await notifyTelegram(db, {
      from: message.from, to: message.to, subject: parsed.subject || '(No Subject)',
      text: parsed.text, attachmentCount: parsed.attachments?.length || 0,
    });

    // Tell subscribed projects that mail arrived (read scope fetches the body)
    await emitMailEvent(db, 'received', {
      id,
      from: message.from,
      to: message.to,
      subject: parsed.subject || '(No Subject)',
      preview: (parsed.text || '').slice(0, 300),
      attachments: storedAttachments,
      received_at: new Date().toISOString(),
    });

    await forwardToDestination(db, message);

    // Fire a web push notification to registered devices (never fatal)
    await notifyAllSubscriptions(db);

    console.log(`Email received and stored: ${id} from ${message.from} to ${message.to} with ${parsed.attachments?.length || 0} attachments`);
  } catch (error) {
    // Storage or notification failure: accept the message rather than ask
    // Cloudflare to retry, but say so loudly in the worker log.
    console.error('Error storing inbound email:', error);
  }
}

/** Optional copy of inbound mail to the owner's real mailbox. */
async function forwardToDestination(db: DatabaseQueries, message: ForwardableEmailMessage): Promise<void> {
  const destinationEmail = await db.getSetting('destination_email');
  if (!destinationEmail) return;
  try {
    await message.forward(destinationEmail);
  } catch (error) {
    console.warn(`Forwarding to ${destinationEmail} failed:`, (error as Error).message);
  }
}

/**
 * Email event handler for Cloudflare Workers
 */
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
};
