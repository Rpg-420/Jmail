import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { DatabaseQueries, type ApiToken, type Email } from '../db/queries';
import { extractBearerToken } from './auth';
import { sha256Hex, sqliteDateTime } from '../lib/utils';
import { isValidEmail, isAllowedContentType } from '../lib/validation';
import { RateLimiter, getClientIP } from '../lib/rate-limit';
import {
  storeAttachment,
  loadAttachmentBytes,
  base64ToBytes,
  validateOutgoingAttachments,
  type AttachmentLimits,
} from '../lib/attachments';
import { contentDispositionAttachment } from '../lib/utils';
import { deliverStoredEmail, parseAddressList, recordRecipientsAsContacts, sendRetryDeadline } from '../lib/mailer';
import { emitMailEvent } from '../lib/webhooks-out';
import { listProviderStatuses } from '../lib/providers';
import { QuotaExhaustedError, PermanentSendError } from '../lib/providers/types';
import { DRAIN_LEASE_SECONDS, utcDay } from '../lib/backoff';

export interface Env {
  DB: D1Database;
  ATTACHMENTS?: R2Bucket;
}

type Scope = 'send' | 'read' | 'status';

const MAX_RECIPIENTS = 50;             // every supported relay caps at 50 per message
const MAX_IDEMPOTENCY_KEY_LENGTH = 120;
const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  perFile: 5 * 1024 * 1024,
  total: 10 * 1024 * 1024,
  count: 10,
};

type V1Context = Context<{ Bindings: Env; Variables: { apiToken: ApiToken; apiScopes: string[] } }>;

const v1 = new Hono<{ Bindings: Env; Variables: { apiToken: ApiToken; apiScopes: string[] } }>();

/** Headers a caller may set; envelope and identity headers stay ours. */
const ALLOWED_CUSTOM_HEADER_PREFIX = 'x-';
const ALLOWED_CUSTOM_HEADERS = new Set(['reply-to', 'in-reply-to', 'references']);
const FORBIDDEN_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'content-type', 'mime-version',
  'message-id', 'date', 'sender', 'return-path', 'received', 'dkim-signature',
]);

function badRequest(c: V1Context, message: string): Response {
  return c.json({ error: 'invalid_request', message }, 400);
}

function formatRecipient(recipient: { name?: string; email: string }): string {
  return recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email;
}

interface ParsedAddressList {
  list: Array<{ name?: string; email: string }>;
  error?: string;
}

function addressesFrom(value: unknown, field: string): ParsedAddressList {
  if (value === undefined || value === null || value === '') return { list: [] };
  const raw = Array.isArray(value) ? value : [value];
  const list: Array<{ name?: string; email: string }> = [];

  for (const entry of raw) {
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as { email?: unknown; name?: unknown };
      if (typeof record.email !== 'string' || !isValidEmail(record.email.trim())) {
        return { list: [], error: `Invalid ${field} address` };
      }
      list.push({
        email: record.email.trim(),
        name: typeof record.name === 'string' ? record.name.slice(0, 200) : undefined,
      });
      continue;
    }
    if (typeof entry !== 'string') return { list: [], error: `${field} must be a string or an array of strings` };

    const parsed = parseAddressList(entry);
    if (parsed.length === 0) return { list: [], error: `Invalid ${field} address` };
    for (const recipient of parsed) {
      if (!isValidEmail(recipient.email)) return { list: [], error: `Invalid ${field} address "${recipient.email}"` };
      list.push(recipient);
    }
  }

  if (list.length > MAX_RECIPIENTS) {
    return { list: [], error: `${field} exceeds ${MAX_RECIPIENTS} recipients` };
  }
  return { list };
}

function sanitizeHeaders(value: unknown): { headers?: Record<string, string>; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'headers must be an object' };

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return { error: 'headers: max 20 entries' };

  const headers: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower)) return { error: `header "${name}" is set by the mail server` };
    if (!lower.startsWith(ALLOWED_CUSTOM_HEADER_PREFIX) && !ALLOWED_CUSTOM_HEADERS.has(lower)) {
      return { error: `header "${name}" is not allowed; use an X- prefixed name` };
    }
    if (typeof rawValue !== 'string') return { error: `header "${name}" must be a string` };
    // eslint-disable-next-line no-control-regex
    if (/[\r\n]/.test(rawValue)) return { error: `header "${name}" contains a line break` };
    headers[name] = rawValue.slice(0, 500);
  }
  return { headers: Object.keys(headers).length > 0 ? headers : undefined };
}

function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Raw headers, truncated: useful for threading, useless for exfiltration. */
function safeHeaders(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      const text = Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
      out[name] = text.slice(0, 500);
      if (Object.keys(out).length >= 60) break;
    }
    return out;
  } catch {
    return null;
  }
}

/** Public shape of a message for API consumers — no bodies, no raw rows. */
function messageView(email: Email): Record<string, unknown> {
  return {
    id: email.id,
    direction: email.type === 'received' ? 'inbound' : 'outbound',
    from: email.from_address,
    to: email.to_address,
    cc: email.cc,
    subject: email.subject,
    status: email.type === 'received' ? 'received' : (email.delivery_status ?? 'pending'),
    provider: email.provider,
    attempts: email.attempts,
    last_error: email.last_error,
    labels: safeJsonArray(email.labels),
    message_id: email.message_id,
    thread_id: email.thread_id,
    created_at: email.created_at,
    scheduled_at: email.scheduled_at,
  };
}

async function settingsNumber(db: DatabaseQueries, key: string, fallback: number): Promise<number> {
  const raw = await db.getSetting(key);
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nextUtcMidnightSeconds(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
}

/**
 * Bearer authentication for every /api/v1 route. Failed lookups are rate
 * limited per IP so the surface cannot be used to brute-force tokens.
 */
v1.use('*', async (c: V1Context, next: Next) => {
  const db = new DatabaseQueries(c.env.DB);
  const rawToken = extractBearerToken(c.req.header('Authorization'));

  if (!rawToken || rawToken.length > 200) {
    return c.json({ error: 'unauthorized', message: 'Provide a bearer token: Authorization: Bearer <token>' }, 401);
  }

  const ipLimiter = new RateLimiter(c.env.DB, { windowMs: 15 * 60 * 1000, maxRequests: 100, keyPrefix: 'v1auth' });
  const ipResult = await ipLimiter.check(getClientIP(c.req.raw));
  if (!ipResult.allowed) {
    return c.json({ error: 'rate_limited', message: 'Too many auth attempts from this address' }, 429);
  }

  const token = await db.getApiTokenByHash(await sha256Hex(rawToken));
  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Unknown or revoked token' }, 401);
  }

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(token.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((scope): scope is string => typeof scope === 'string');
  } catch {
    scopes = [];
  }

  c.set('apiToken', token);
  c.set('apiScopes', scopes);
  await db.touchApiToken(token.id);
  return next();
});

function requireScope(c: V1Context, scope: Scope): Response | null {
  if (c.get('apiScopes').includes(scope)) return null;
  return c.json({ error: 'forbidden', message: `Token is missing the "${scope}" scope` }, 403);
}

/**
 * POST /api/v1/send
 *
 * Stores the message as a queue row, then attempts delivery in-request so
 * transactional mail is not stuck behind the cron.
 *   200 = accepted by a relay (or a replayed idempotency key)
 *   202 = queued; the mail server keeps retrying
 *   422 = a relay rejected the message itself; retrying will not help
 */
v1.post('/send', async (c: V1Context) => {
  const denied = requireScope(c, 'send');
  if (denied) return denied;

  const db = new DatabaseQueries(c.env.DB);
  const token = c.get('apiToken');

  const perMinute = new RateLimiter(c.env.DB, {
    windowMs: 60 * 1000,
    maxRequests: token.rate_per_min,
    keyPrefix: `v1token:${token.id}`,
  });
  const limit = await perMinute.check('send');
  c.header('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: `Token limit is ${token.rate_per_min} requests per minute`,
        retry_after: Math.ceil((limit.resetTime - Date.now()) / 1000),
      },
      429
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return badRequest(c, 'Body must be valid JSON');
  }

  // Per-token daily budget, independent of provider quota
  const usage = await db.getTokenUsage(token.id, utcDay());
  if (usage.sent + usage.failed >= token.daily_budget) {
    c.header('Retry-After', String(Math.max(1, nextUtcMidnightSeconds() - Math.floor(Date.now() / 1000))));
    return c.json(
      { error: 'budget_exceeded', message: `Token daily budget of ${token.daily_budget} sends is used up`, sent_today: usage.sent },
      429
    );
  }

  const to = addressesFrom(payload.to, 'to');
  if (to.error) return badRequest(c, to.error);
  if (to.list.length === 0) return badRequest(c, 'to is required');

  const cc = addressesFrom(payload.cc, 'cc');
  if (cc.error) return badRequest(c, cc.error);
  const bcc = addressesFrom(payload.bcc, 'bcc');
  if (bcc.error) return badRequest(c, bcc.error);

  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  if (!subject) return badRequest(c, 'subject is required');
  if (subject.length > 998) return badRequest(c, 'subject exceeds 998 characters');

  const text = typeof payload.text === 'string' ? payload.text : undefined;
  const html = typeof payload.html === 'string' ? payload.html : undefined;
  if (!text && !html) return badRequest(c, 'Either text or html body is required');
  if (text && text.length > 1_000_000) return badRequest(c, 'text body exceeds 1MB');
  if (html && html.length > 2_000_000) return badRequest(c, 'html body exceeds 2MB');

  const replyTo = addressesFrom(payload.reply_to ?? payload.replyTo, 'reply_to');
  if (replyTo.error) return badRequest(c, replyTo.error);

  const { headers: customHeaders, error: headerError } = sanitizeHeaders(payload.headers);
  if (headerError) return badRequest(c, headerError);

  // Identity: a token pinned to an address may not impersonate another one.
  const requestedFrom = addressesFrom(payload.from, 'from');
  if (requestedFrom.error) return badRequest(c, requestedFrom.error);

  const knownAddresses = await db.listAddresses();
  let fromAddress = requestedFrom.list[0]?.email;
  if (token.identity_address) {
    if (fromAddress && fromAddress.toLowerCase() !== token.identity_address.toLowerCase()) {
      return c.json({ error: 'identity_mismatch', message: `This token may only send as ${token.identity_address}` }, 403);
    }
    fromAddress = token.identity_address;
  }
  if (!fromAddress) return badRequest(c, 'from is required (or pin an identity address on the token)');

  const addressIsKnown = knownAddresses.some(address => address.address.toLowerCase() === fromAddress!.toLowerCase());
  if (!token.identity_address && !addressIsKnown) {
    return c.json({
      error: 'unverified_sender',
      message: `"${fromAddress}" is not a configured From address. Add it under Settings → Addresses, or pin the token identity.`,
    }, 403);
  }

  const attachmentError = validateOutgoingAttachments(
    payload.attachments,
    {
      perFile: await settingsNumber(db, 'max_api_attachment_bytes', DEFAULT_ATTACHMENT_LIMITS.perFile),
      total: await settingsNumber(db, 'max_api_total_bytes', DEFAULT_ATTACHMENT_LIMITS.total),
      count: DEFAULT_ATTACHMENT_LIMITS.count,
    },
    isAllowedContentType
  );
  if (attachmentError) return badRequest(c, attachmentError);

  const idempotencyKey = typeof payload.idempotency_key === 'string'
    ? payload.idempotency_key.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
    : null;
  if (idempotencyKey) {
    const existing = await db.findEmailByIdempotencyKey(token.id, idempotencyKey);
    if (existing) return c.json({ ...messageView(existing), deduplicated: true }, 200);
  }

  let scheduledAt = sqliteDateTime(new Date());
  let sendLater = false;
  const rawSchedule = payload.send_at ?? payload.schedule_at;
  if (typeof rawSchedule === 'string' && rawSchedule) {
    const when = new Date(rawSchedule);
    if (isNaN(when.getTime())) return badRequest(c, 'send_at is not a valid ISO datetime');
    if (when.getTime() < Date.now() - 60_000) return badRequest(c, 'send_at is in the past');
    sendLater = when.getTime() > Date.now();
    scheduledAt = sqliteDateTime(sendLater ? when : new Date());
  }

  const labels = Array.isArray(payload.labels)
    ? [...new Set(
        payload.labels
          .filter((label): label is string => typeof label === 'string')
          .map(label => label.trim().slice(0, 40))
          .filter(Boolean)
      )].slice(0, 20)
    : [];
  if (!labels.includes(token.name)) labels.push(token.name);

  const knownAddress = knownAddresses.find(address => address.address.toLowerCase() === fromAddress!.toLowerCase());
  const displayName = requestedFrom.list[0]?.name ?? knownAddress?.display_name ?? null;
  const fromAddressFinal = fromAddress;

  const id = crypto.randomUUID();
  await db.createEmail({
    id,
    type: 'scheduled',
    from_address: displayName ? `${displayName} <${fromAddressFinal}>` : fromAddressFinal,
    to_address: to.list.map(formatRecipient).join(', '),
    cc: cc.list.length ? cc.list.map(formatRecipient).join(', ') : null,
    bcc: bcc.list.length ? bcc.list.map(recipient => recipient.email).join(', ') : null,
    subject,
    body_text: text ?? null,
    body_html: html ?? null,
    headers: customHeaders ? JSON.stringify({ ...customHeaders, ...(replyTo.list[0] ? { 'Reply-To': formatRecipient(replyTo.list[0]) } : {}) }) : replyTo.list[0] ? JSON.stringify({ 'Reply-To': formatRecipient(replyTo.list[0]) }) : null,
    raw_size: null,
    is_read: 1,
    is_starred: 0,
    labels: JSON.stringify(labels),
    in_reply_to: customHeaders?.['In-Reply-To'] ?? null,
    delivery_status: 'queued',
    scheduled_at: scheduledAt,
    token_id: token.id,
    idempotency_key: idempotencyKey,
  });

  const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []) as Array<{
    filename: string;
    content: string;
    content_type?: string;
    contentType?: string;
  }>;
  for (const attachment of attachments) {
    await storeAttachment(db, c.env.ATTACHMENTS, {
      emailId: id,
      filename: attachment.filename,
      contentType: attachment.content_type ?? attachment.contentType ?? 'application/octet-stream',
      bytes: base64ToBytes(attachment.content),
    });
  }

  const stored = await db.getEmail(id);
  if (!stored) return c.json({ error: 'storage_failed', message: 'Message could not be persisted' }, 500);

  if (sendLater) {
    return c.json({ ...messageView(stored), queued_for: scheduledAt }, 202);
  }

  // The row is due the moment it is written, so a cron tick landing inside this
  // request can already own it. Only the holder of the claim sends inline; the
  // other one leaves the message to the queue rather than posting it twice.
  if (!(await db.claimQueueEmail(id, DRAIN_LEASE_SECONDS))) {
    return c.json({ ...messageView(stored), status: 'queued' }, 202);
  }

  try {
    const outcome = await deliverStoredEmail(db, c.env.ATTACHMENTS, stored);
    await db.markEmailSent(id, outcome.providerMessageId, outcome.provider);
    await db.recordTokenUsage(token.id, utcDay(), 'sent');
    // The caller gets a 200 either way, but subscribers are told in parallel —
    // otherwise in-request sends would be the only ones that never webhooks.
    await recordRecipientsAsContacts(db, stored);
    await emitMailEvent(db, 'sent', {
      id,
      to: stored.to_address,
      subject: stored.subject,
      provider: outcome.provider,
      provider_message_id: outcome.providerMessageId,
      token_id: token.id,
    });
    return c.json({
      ...messageView(stored),
      status: 'sent',
      provider: outcome.provider,
      provider_message_id: outcome.providerMessageId,
    }, 200);
  } catch (error) {
    const details = (error as Error).message || 'Unknown error';

    if (error instanceof PermanentSendError) {
      await db.updateEmailQueueFields(id, {
        delivery_status: 'failed',
        attempts: 1,
        next_attempt_at: null,
        last_error: details.slice(0, 500),
        provider: null,
      });
      await db.recordTokenUsage(token.id, utcDay(), 'failed');
      await emitMailEvent(db, 'failed', {
        id,
        to: stored.to_address,
        subject: stored.subject,
        error: details.slice(0, 300),
        attempts: 1,
        token_id: token.id,
      });
      const refreshed = await db.getEmail(id);
      return c.json({ ...messageView(refreshed ?? stored), error: 'rejected_by_relay', detail: details.slice(0, 400) }, 422);
    }

    // Quota or a relay outage: the row stays queued and the cron drains it.
    const outOfQuota = error instanceof QuotaExhaustedError;
    await db.updateEmailQueueFields(id, {
      delivery_status: outOfQuota ? 'deferred' : 'queued',
      attempts: outOfQuota ? 0 : 1,
      next_attempt_at: outOfQuota ? null : sendRetryDeadline(1),
      last_error: details.slice(0, 500),
      provider: null,
    });
    return c.json({ ...messageView(stored), status: 'queued', retrying: true, reason: details.slice(0, 200) }, 202);
  }
});

/**
 * GET /api/v1/messages — outbound mail created by this token, or inbound
 * mail when the token carries the read scope.
 */
v1.get('/messages', async (c: V1Context) => {
  const db = new DatabaseQueries(c.env.DB);
  const token = c.get('apiToken');

  const rawLimit = Number.parseInt(c.req.query('limit') || '25', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
  const offset = Math.max(Number.parseInt(c.req.query('offset') || '0', 10) || 0, 0);

  if (c.req.query('direction') === 'inbound') {
    const denied = requireScope(c, 'read');
    if (denied) return denied;
    const results = await db.listEmails('received', {
      limit,
      offset,
      unreadOnly: c.req.query('unread') === 'true',
      label: c.req.query('label') || undefined,
    });
    return c.json({ messages: results.map(messageView), limit, offset });
  }

  const results = await db.listEmailsByToken(token.id, {
    limit,
    offset,
    status: c.req.query('status') || undefined,
    idempotencyKey: c.req.query('idempotency_key') || undefined,
  });
  return c.json({ messages: results.map(messageView), limit, offset });
});

/** GET /api/v1/messages/:id — delivery status for one message. */
v1.get('/messages/:id', async (c: V1Context) => {
  const db = new DatabaseQueries(c.env.DB);
  const token = c.get('apiToken');
  const email = await db.getEmail(c.req.param('id') ?? '');

  if (!email) return c.json({ error: 'not_found', message: 'No such message' }, 404);

  const ownsIt = email.token_id === token.id;
  const canReadInbound = email.type === 'received' && c.get('apiScopes').includes('read');
  if (!ownsIt && !canReadInbound) {
    // Do not disclose that the id exists under someone else's token.
    return c.json({ error: 'not_found', message: 'No such message' }, 404);
  }

  const view = messageView(email);
  if (canReadInbound) {
    // Inbound consumption: a project reading its own support mailbox needs
    // the body, which the list endpoint deliberately omits.
    Object.assign(view, {
      text: email.body_text,
      html: email.body_html,
      headers: safeHeaders(email.headers),
      attachments: (await db.getAttachmentsByEmailId(email.id)).map(att => ({
        id: att.id,
        filename: att.filename,
        content_type: att.content_type,
        size: att.size,
      })),
    });
  }

  return c.json(view);
});

/** Attachment bytes for an inbound message (read scope). */
v1.get('/messages/:id/attachments/:attachmentId', async (c: V1Context) => {
  const denied = requireScope(c, 'read');
  if (denied) return denied;

  const db = new DatabaseQueries(c.env.DB);
  const email = await db.getEmail(c.req.param('id') ?? '');
  if (!email || email.type !== 'received') return c.json({ error: 'not_found', message: 'No such message' }, 404);

  const attachment = await db.getAttachment(c.req.param('attachmentId') ?? '');
  if (!attachment || attachment.email_id !== email.id) return c.json({ error: 'not_found', message: 'No such attachment' }, 404);

  const bytes = await loadAttachmentBytes(c.env.ATTACHMENTS, attachment);
  if (!bytes) return c.json({ error: 'attachment_unavailable', message: 'Stored bytes are missing' }, 500);

  return new Response(bytes as unknown as ArrayBuffer, {
    headers: {
      'Content-Type': attachment.content_type || 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': contentDispositionAttachment(attachment.filename),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
});

/** Download a message as .eml (read scope). */
v1.get('/messages/:id/eml', async (c: V1Context) => {
  const denied = requireScope(c, 'read');
  if (denied) return denied;

  const db = new DatabaseQueries(c.env.DB);
  const email = await db.getEmail(c.req.param('id') ?? '');
  if (!email) return c.json({ error: 'not_found', message: 'No such message' }, 404);

  const createdAt = new Date(`${email.created_at.replace(' ', 'T')}Z`);
  const eml = [
    `Message-ID: ${email.message_id ?? `<${email.id}@jmail>`}`,
    `Date: ${isNaN(createdAt.getTime()) ? email.created_at : createdAt.toUTCString()}`,
    `From: ${email.from_address}`,
    `To: ${email.to_address}`,
    `Subject: ${email.subject ?? ''}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    email.body_text ?? (email.body_html ? '[message body is HTML only]' : ''),
  ].join('\r\n');

  return new Response(eml, {
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="message-${email.id}.eml"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
});

/** Mark an inbound message read (read scope). */
v1.post('/messages/:id/read', async (c: V1Context) => {
  const denied = requireScope(c, 'read');
  if (denied) return denied;
  const db = new DatabaseQueries(c.env.DB);
  await db.markAsRead(c.req.param('id') ?? '');
  return c.json({ success: true });
});

/**
 * GET /api/v1/quota — remaining free-tier sending capacity, so a project can
 * back off before the mail server has to refuse it.
 */
v1.get('/quota', async (c: V1Context) => {
  const denied = requireScope(c, 'status');
  if (denied) return denied;

  const db = new DatabaseQueries(c.env.DB);
  const token = c.get('apiToken');
  const [providers, usage] = await Promise.all([
    listProviderStatuses(db),
    db.getTokenUsage(token.id, utcDay()),
  ]);

  return c.json({
    day: utcDay(),
    token: {
      name: token.name,
      daily_budget: token.daily_budget,
      sent_today: usage.sent,
      failed_today: usage.failed,
      remaining_today: Math.max(0, token.daily_budget - usage.sent - usage.failed),
      rate_per_min: token.rate_per_min,
    },
    providers: providers
      .filter(provider => provider.configured)
      .map(provider => ({
        id: provider.id,
        label: provider.label,
        quota_day: provider.quotaDay,
        used_day: provider.usedDay,
        remaining_day: provider.remaining,
      })),
    total_remaining_today: providers
      .filter(provider => provider.configured)
      .reduce((sum, provider) => sum + (provider.remaining ?? 0), 0),
  });
});

/** GET /api/v1/whoami — token identity and scopes; the first call an integration makes. */
v1.get('/whoami', async (c: V1Context) => {
  const token = c.get('apiToken');
  return c.json({
    id: token.id,
    name: token.name,
    scopes: c.get('apiScopes'),
    identity_address: token.identity_address,
    rate_per_min: token.rate_per_min,
    daily_budget: token.daily_budget,
    created_at: token.created_at,
    last_used_at: token.last_used_at,
  });
});

export default v1;
