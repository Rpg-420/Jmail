import type { DatabaseQueries, WebhookEndpoint } from '../db/queries';
import { generateId, hmacSha256Hex, timingSafeEqual } from './utils';
import { DRAIN_LEASE_SECONDS, MAX_WEBHOOK_ATTEMPTS, retryAt, webhookRetryDelayMs } from './backoff';

/**
 * Outbound webhooks: the mail server telling other projects what happened
 * to mail they submitted. Payloads are HMAC-signed so a project can prove
 * the call came from this deployment without trusting the transport.
 */

export const WEBHOOK_EVENTS = ['sent', 'delivered', 'opened', 'bounced', 'deferred', 'failed', 'received'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Refuse loopback/private targets. The endpoint list is admin-only, but a
 * signing webhook is a poor way to reach an internal service, so the URL is
 * validated at creation time instead of trusting it later.
 */
export function isPublicWebhookUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;

  // IPv4 literal checks
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;   // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;              // multicast / reserved
  }

  // IPv6 literal: ::1, fc00::/7 (unique local), fe80::/10 (link-local)
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return false;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return false;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
  }

  return true;
}

export function assertValidWebhookEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0) return [...WEBHOOK_EVENTS];
  const cleaned = [...new Set(events.filter((e): e is string => typeof e === 'string'))];
  return cleaned.filter(event => (WEBHOOK_EVENTS as readonly string[]).includes(event));
}

/**
 * Queue one delivery row per subscribed endpoint. Each row gets its own id
 * (and its own payload) so a project can dedupe per endpoint, and so two
 * subscribers never collide on the primary key.
 */
export async function emitMailEvent(
  db: DatabaseQueries,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<number> {
  const tokenId = typeof data.token_id === 'string' ? data.token_id : null;
  const endpoints = await db.listEndpointsForEvent(event, tokenId);
  if (endpoints.length === 0) return 0;

  const occurredAt = new Date().toISOString();
  for (const endpoint of endpoints) {
    const deliveryId = generateId();
    await db.queueWebhookDelivery({
      id: deliveryId,
      endpoint_id: endpoint.id,
      event,
      payload: JSON.stringify({
        id: deliveryId,
        type: event,
        occurred_at: occurredAt,
        data,
      }),
    });
  }
  return endpoints.length;
}

/**
 * Stripe-style signature: the timestamp is signed alongside the body so a
 * receiver can reject replays of an old webhook.
 */
export async function signPayload(secret: string, timestamp: number, body: string): Promise<string> {
  const digest = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return `t=${timestamp},v1=${digest}`;
}

/** Reference implementation for integrators' own webhook receivers. */
export async function verifySignature(secret: string, header: string, body: string, toleranceSec = 300): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const piece of header.split(',')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
  }
  if (!parts.t || !parts.v1) return false;

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;

  return timingSafeEqual(await hmacSha256Hex(secret, `${timestamp}.${body}`), parts.v1);
}

async function deliverOne(endpoint: WebhookEndpoint, body: string, event: string, deliveryId: string): Promise<{ ok: boolean; error: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'JMail-Webhook/1.0',
        'X-JMail-Event': event,
        'X-JMail-Delivery': deliveryId,
        'X-JMail-Signature': await signPayload(endpoint.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, error: '' };
    // 4xx other than 408/429 will never succeed on retry
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      return { ok: false, error: `HTTP ${response.status} (permanent)`, };
    }
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface WebhookReport {
  delivered: number;
  retried: number;
  failed: number;
  /** Rows another drain already owns; they stay queued for the next tick. */
  skipped: number;
}

/** Called from cron; a project that is briefly down does not lose events. */
export async function drainWebhookDeliveries(db: DatabaseQueries, limit = 25): Promise<WebhookReport> {
  const report: WebhookReport = { delivered: 0, retried: 0, failed: 0, skipped: 0 };
  const due = await db.listDueWebhookDeliveries(limit);

  for (const delivery of due) {
    if (!(await db.claimWebhookDelivery(delivery.id, DRAIN_LEASE_SECONDS))) {
      report.skipped++;
      continue;
    }

    const endpoint = await db.getWebhookEndpoint(delivery.endpoint_id);
    if (!endpoint || !endpoint.active) {
      await db.markWebhookFailed(delivery.id, delivery.attempts, 'endpoint removed or disabled');
      report.failed++;
      continue;
    }

    const attempts = delivery.attempts + 1;
    const result = await deliverOne(endpoint, delivery.payload, delivery.event, delivery.id);

    if (result.ok) {
      await db.markWebhookDelivered(delivery.id);
      report.delivered++;
      continue;
    }

    const permanent = result.error.includes('(permanent)') || attempts >= MAX_WEBHOOK_ATTEMPTS;
    if (permanent) {
      await db.markWebhookFailed(delivery.id, attempts, result.error);
      report.failed++;
      continue;
    }

    await db.markWebhookAttemptFailed(
      delivery.id,
      attempts,
      retryAt(webhookRetryDelayMs(attempts)),
      result.error
    );
    report.retried++;
  }

  return report;
}
