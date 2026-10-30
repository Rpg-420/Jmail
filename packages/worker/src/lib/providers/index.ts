import type { DatabaseQueries } from '../../db/queries';
import { brevoProvider } from './brevo';
import { resendProvider } from './resend';
import {
  PermanentSendError,
  QuotaExhaustedError,
  TransientSendError,
  type MailProvider,
  type OutboundMessage,
  type ProviderId,
} from './types';

const REGISTRY: Record<ProviderId, MailProvider> = {
  brevo: brevoProvider,
  resend: resendProvider,
};

export const PROVIDER_IDS = Object.keys(REGISTRY) as ProviderId[];

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  quotaDay: number | null;
  quotaMonth: number | null;
  usedDay: number;
  usedMonth: number;
  /** null when the provider has no published cap */
  remaining: number | null;
  /** Limits published by the relay itself — never exceeded by our checks. */
  maxRecipients: number;
  maxMessageBytes: number;
}

export interface SendAttemptFailure {
  provider: ProviderId;
  kind: 'permanent' | 'transient' | 'unconfigured';
  message: string;
}

export interface ProviderSendOutcome {
  provider: ProviderId;
  providerMessageId: string;
}

function keySetting(id: ProviderId): string {
  return `provider_key_${id}`;
}

function dayQuotaSetting(id: ProviderId): string {
  return `provider_quota_${id}_day`;
}

function monthQuotaSetting(id: ProviderId): string {
  return `provider_quota_${id}_month`;
}

function parseQuota(raw: string | null): number | null {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Legacy single-provider setting stays readable so existing installs keep working. */
async function readProviderKey(db: DatabaseQueries, id: ProviderId): Promise<string | null> {
  const key = await db.getSetting(keySetting(id));
  if (key) return key;
  if (id === 'brevo') return await db.getSetting('brevo_api_key');
  return null;
}

export function currentDayPeriod(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentMonthPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Configured providers in failover order, with locally tracked quota.
 * Quota is enforced here, before a relay ever rejects us, because a
 * rejected send still burns the relay's reputation and our retry budget.
 */
export async function listProviderStatuses(db: DatabaseQueries): Promise<ProviderStatus[]> {
  let order: ProviderId[] = [];
  try {
    const raw = await db.getSetting('provider_order');
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) order = parsed.filter((id): id is ProviderId => typeof id === 'string' && id in REGISTRY);
  } catch {
    order = [];
  }
  const ids: ProviderId[] = [...order, ...PROVIDER_IDS.filter(id => !order.includes(id))];

  const statuses: ProviderStatus[] = [];
  for (const id of ids) {
    const [key, dayQuota, monthQuota, usedDay, usedMonth] = await Promise.all([
      readProviderKey(db, id),
      db.getSetting(dayQuotaSetting(id)),
      db.getSetting(monthQuotaSetting(id)),
      db.getProviderUsage(id, 'day', currentDayPeriod()),
      db.getProviderUsage(id, 'month', currentMonthPeriod()),
    ]);
    const quotaDay = parseQuota(dayQuota) ?? REGISTRY[id].limits.freeDaily;
    const quotaMonth = parseQuota(monthQuota);
    const remaining = !key
      ? null
      : Math.min(
          quotaDay === null ? Number.POSITIVE_INFINITY : Math.max(0, quotaDay - usedDay),
          quotaMonth === null ? Number.POSITIVE_INFINITY : Math.max(0, quotaMonth - usedMonth)
        );
    statuses.push({
      id,
      label: REGISTRY[id].label,
      configured: !!key,
      quotaDay,
      quotaMonth,
      usedDay,
      usedMonth,
      remaining: Number.isFinite(remaining) ? remaining : null,
      maxRecipients: REGISTRY[id].limits.maxRecipients,
      maxMessageBytes: REGISTRY[id].limits.maxMessageBytes,
    });
  }
  return statuses;
}

/**
 * Try each usable provider in order until one accepts the message.
 *
 * A permanent rejection on one relay does not end the attempt: an
 * unverified sender identity on provider A is usually fine on provider B.
 * The message only dies when every provider rejected it permanently.
 */
export async function sendThroughProviders(
  db: DatabaseQueries,
  message: OutboundMessage
): Promise<ProviderSendOutcome> {
  const statuses = await listProviderStatuses(db);

  const recipientCount =
    (message.to?.length ?? 0) + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0);
  // base64 inflates bytes by 4/3; this estimate is enough to pick a relay
  const attachmentBytes = Math.floor(
    (message.attachments ?? []).reduce((sum, att) => sum + att.content.length, 0) * 0.75
  );
  const bodyBytes = (message.text?.length ?? 0) + (message.html?.length ?? 0);
  const messageBytes = attachmentBytes + bodyBytes + message.subject.length;

  const usable = statuses.filter(status =>
    status.configured &&
    (status.remaining === null || status.remaining > 0) &&
    recipientCount <= status.maxRecipients &&
    messageBytes <= status.maxMessageBytes
  );

  if (usable.length === 0) {
    if (recipientCount > Math.max(...statuses.map(status => status.maxRecipients), 0)) {
      throw new PermanentSendError(
        `${recipientCount} recipients exceeds every relay's limit`,
        statuses[0]?.id ?? 'brevo'
      );
    }
    if (statuses.some(status => status.configured)) {
      // Too big for every relay is permanent; out of quota is not.
      if (messageBytes > Math.max(...statuses.filter(s => s.configured).map(s => s.maxMessageBytes), 0)) {
        throw new PermanentSendError(
          `Message is ~${Math.round(messageBytes / 1024 / 1024)}MB, over every relay's size limit`,
          statuses[0]?.id ?? 'brevo'
        );
      }
      throw new QuotaExhaustedError('Every configured provider is at its daily or monthly quota');
    }
    throw new TransientSendError('No sending provider is configured', 'brevo');
  }

  const failures: SendAttemptFailure[] = [];

  for (const status of usable) {
    const provider = REGISTRY[status.id];
    const apiKey = await readProviderKey(db, status.id);
    if (!apiKey) {
      failures.push({ provider: status.id, kind: 'unconfigured', message: 'no api key' });
      continue;
    }

    try {
      const result = await provider.send(apiKey, message);
      await db.recordProviderUsage(status.id, 'day', currentDayPeriod());
      await db.recordProviderUsage(status.id, 'month', currentMonthPeriod());
      return { provider: status.id, providerMessageId: result.providerMessageId };
    } catch (error) {
      const messageText = (error as Error).message || 'unknown error';
      if (error instanceof PermanentSendError) {
        failures.push({ provider: status.id, kind: 'permanent', message: messageText });
        continue;
      }
      failures.push({ provider: status.id, kind: 'transient', message: messageText });
      continue;
    }
  }

  const allPermanent = failures.length > 0 && failures.every(failure => failure.kind === 'permanent');
  const summary = failures.map(failure => `${failure.provider}: ${failure.message}`).join(' | ').slice(0, 900);

  if (allPermanent) {
    throw new PermanentSendError(summary, failures[0].provider);
  }
  throw new TransientSendError(summary || 'all providers failed', failures[0]?.provider ?? 'brevo');
}

export async function verifyProviderKey(db: DatabaseQueries, id: ProviderId, apiKey: string): Promise<void> {
  await REGISTRY[id].verify(apiKey);
}

export function providerLabel(id: string): string {
  return (REGISTRY as Record<string, MailProvider | undefined>)[id]?.label ?? id;
}
