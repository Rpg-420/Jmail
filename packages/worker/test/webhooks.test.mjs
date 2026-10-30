import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './ts-hooks.mjs';

const {
  isPublicWebhookUrl,
  assertValidWebhookEvents,
  signPayload,
  verifySignature,
  emitMailEvent,
  drainWebhookDeliveries,
  WEBHOOK_EVENTS,
} = await import('../src/lib/webhooks-out.ts');
const { webhookRetryDelayMs, MAX_WEBHOOK_ATTEMPTS, sendRetryDelayMs, MAX_SEND_ATTEMPTS } = await import('../src/lib/backoff.ts');

const secret = 'whsec_test0123456789';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // An unstubbed call here means a test would dial the real internet.
  globalThis.fetch = async () => {
    throw new Error('test attempted a real network call');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('signs and verifies with the reference implementation integrators copy', async () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'sent', data: { id: 'mail_1' } });
  const timestamp = Math.floor(Date.now() / 1000);
  const header = await signPayload(secret, timestamp, body);

  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(await verifySignature(secret, header, body), true);
});

test('rejects a tampered body, a wrong secret and a missing part', async () => {
  const body = '{"a":1}';
  const header = await signPayload(secret, Math.floor(Date.now() / 1000), body);

  assert.equal(await verifySignature(secret, header, '{"a":2}'), false);
  assert.equal(await verifySignature('whsec_othersecret', header, body), false);
  assert.equal(await verifySignature(secret, header.replace('v1=', 'v2='), body), false);
});

test('rejects replays older than the tolerance window', async () => {
  const body = '{"a":1}';
  const stale = Math.floor(Date.now() / 1000) - 3600;
  const header = await signPayload(secret, stale, body);

  assert.equal(await verifySignature(secret, header, body, 300), false);
  assert.equal(await verifySignature(secret, header, body, 7200), true);
});

test('refuses webhook targets that point inside a private network', () => {
  for (const url of [
    'http://127.0.0.1/hook', 'https://localhost:8443/hook', 'http://10.1.2.3/hook',
    'http://172.16.0.9/hook', 'http://192.168.1.1/hook', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/hook', 'http://[fd00::1]/hook', 'http://metadata.internal/hook',
    'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '',
  ]) {
    assert.equal(isPublicWebhookUrl(url), false, `${url} should be refused`);
  }
});

test('accepts normal public endpoints, including paths, ports and query', () => {
  for (const url of [
    'https://hooks.example.com/jmail',
    'https://api.example.com:8443/webhooks/mail',
    'https://example.com/hook?token=abc',
    'http://203.0.113.9/hook',
  ]) {
    assert.equal(isPublicWebhookUrl(url), true, `${url} should be allowed`);
  }
});

test('credentials in a webhook URL are refused', () => {
  assert.equal(isPublicWebhookUrl('https://user:pass@example.com/hook'), false);
});

test('an empty event list subscribes to everything, unknown names are dropped', () => {
  const all = [...WEBHOOK_EVENTS].sort();
  assert.deepEqual([...assertValidWebhookEvents([])].sort(), all);
  assert.deepEqual(assertValidWebhookEvents(['sent', 'sent', 'bogus']), ['sent']);
  assert.deepEqual([...assertValidWebhookEvents('sent')].sort(), all);
});

test('one queue row per endpoint, each with its own delivery id', async () => {
  const queued = [];
  const db = {
    async listEndpointsForEvent(event, tokenId) {
      assert.equal(event, 'sent');
      assert.equal(tokenId, 'tok_1');
      return [{ id: 'ep_1' }, { id: 'ep_2' }];
    },
    async queueWebhookDelivery(row) {
      queued.push(row);
    },
  };

  const count = await emitMailEvent(db, 'sent', { token_id: 'tok_1', id: 'mail_1' });
  const payloads = queued.map(row => JSON.parse(row.payload));

  assert.equal(count, 2);
  assert.equal(new Set(queued.map(row => row.id)).size, 2, 'delivery ids must not collide');
  assert.equal(new Set(payloads.map(payload => payload.id)).size, 2);
  assert.deepEqual(payloads.map(payload => payload.type), ['sent', 'sent']);
});

test('no subscribers means no rows and no work', async () => {
  const db = { async listEndpointsForEvent() { return []; }, async queueWebhookDelivery() { throw new Error('should not queue'); } };
  assert.equal(await emitMailEvent(db, 'received', { id: 'mail_9' }), 0);
});

function deliveryDb(delivery, endpoint, options = {}) {
  const updates = [];
  return {
    updates,
    async listDueWebhookDeliveries() {
      return [delivery];
    },
    async claimWebhookDelivery() {
      return options.claimed !== false;
    },
    async getWebhookEndpoint(id) {
      return id === endpoint.id ? endpoint : null;
    },
    async markWebhookDelivered(id) {
      updates.push({ kind: 'delivered', id });
    },
    async markWebhookFailed(id, attempts, error) {
      updates.push({ kind: 'failed', id, attempts, error });
    },
    async markWebhookAttemptFailed(id, attempts, nextAttemptAt, error) {
      updates.push({ kind: 'retry', id, attempts, nextAttemptAt, error });
    },
  };
}

const baseDelivery = { id: 'del_1', endpoint_id: 'ep_1', event: 'sent', payload: '{"a":1}', attempts: 0 };
const endpoint = { id: 'ep_1', url: 'https://example.com/hook', secret, active: 1 };

test('a successful delivery is marked done and signed with the endpoint secret', async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers, body: options.body });
    return new Response(null, { status: 204 });
  };
  const db = deliveryDb(baseDelivery, endpoint);

  const report = await drainWebhookDeliveries(db);

  assert.deepEqual(report, { delivered: 1, retried: 0, failed: 0, skipped: 0 });
  assert.equal(seen[0].headers['X-JMail-Event'], 'sent');
  assert.equal(seen[0].headers['X-JMail-Delivery'], 'del_1');
  assert.equal(await verifySignature(secret, seen[0].headers['X-JMail-Signature'], seen[0].body), true);
  assert.equal(db.updates[0].kind, 'delivered');
});

test('a 500 response backs off instead of failing, with a growing delay', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  const db = deliveryDb({ ...baseDelivery, attempts: 2 }, endpoint);

  const report = await drainWebhookDeliveries(db);

  assert.deepEqual(report, { delivered: 0, retried: 1, failed: 0, skipped: 0 });
  assert.equal(db.updates[0].kind, 'retry');
  assert.equal(db.updates[0].attempts, 3);
  assert.ok(db.updates[0].nextAttemptAt > new Date().toISOString().slice(0, 19).replace('T', ' '));
});

test('a 400 response is permanent: no endless retries against a broken receiver', async () => {
  globalThis.fetch = async () => new Response('bad request', { status: 400 });
  const db = deliveryDb(baseDelivery, endpoint);

  assert.deepEqual(await drainWebhookDeliveries(db), { delivered: 0, retried: 0, failed: 1, skipped: 0 });
  assert.equal(db.updates[0].kind, 'failed');
  assert.match(db.updates[0].error, /permanent/);
});

test('a 429 from the receiver is retried, not dropped', async () => {
  globalThis.fetch = async () => new Response('slow down', { status: 429 });
  const db = deliveryDb(baseDelivery, endpoint);

  assert.equal((await drainWebhookDeliveries(db)).retried, 1);
});

test('the last attempt gives up rather than retrying forever', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  const db = deliveryDb({ ...baseDelivery, attempts: MAX_WEBHOOK_ATTEMPTS - 1 }, endpoint);

  assert.equal((await drainWebhookDeliveries(db)).failed, 1);
  assert.equal(db.updates[0].attempts, MAX_WEBHOOK_ATTEMPTS);
});

test('a paused or deleted endpoint fails its pending deliveries instead of hanging', async () => {
  globalThis.fetch = async () => {
    throw new Error('must not call a disabled endpoint');
  };
  const db = deliveryDb(baseDelivery, { ...endpoint, active: 0 });

  assert.equal((await drainWebhookDeliveries(db)).failed, 1);
  assert.match(db.updates[0].error, /disabled|removed/);
});

test('a delivery another drain already claimed is left alone', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const db = deliveryDb(baseDelivery, endpoint, { claimed: false });

  assert.deepEqual(await drainWebhookDeliveries(db), { delivered: 0, retried: 0, failed: 0, skipped: 1 });
  assert.equal(calls, 0, 'a losing claim must not post');
  assert.deepEqual(db.updates, [], 'a losing claim must not write the row');
});

test('retry ladders grow monotonically and stay inside their caps', () => {
  for (const [fn, max] of [[webhookRetryDelayMs, MAX_WEBHOOK_ATTEMPTS], [sendRetryDelayMs, MAX_SEND_ATTEMPTS]]) {
    let previous = 0;
    for (let attempt = 1; attempt <= max + 3; attempt++) {
      const delay = fn(attempt);
      assert.ok(delay >= previous, 'delay must never shrink');
      assert.ok(delay <= 48 * 3600_000, 'delay must stay bounded');
      previous = delay;
    }
  }
});
