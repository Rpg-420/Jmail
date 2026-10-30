import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ts-hooks.mjs';
import { fakeD1, writesMatching } from './d1-stub.mjs';

const v1 = (await import('../src/api/v1.ts')).default;
const { sha256Hex } = await import('../src/lib/utils.ts');

const RAW_TOKEN = 'jmail_live_abcdefghijklmnop';
const TOKEN_ID = 'tok_1';
const originalFetch = globalThis.fetch;

function tokenRow(overrides = {}) {
  return {
    id: TOKEN_ID,
    token_hash: 'set-below',
    token_prefix: 'jmail_liv',
    name: 'billing-app',
    scopes: '["send","status","read"]',
    identity_address: null,
    rate_per_min: 60,
    daily_budget: 500,
    created_at: '2026-01-01 00:00:00',
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function storedEmail(overrides = {}) {
  return {
    id: 'mail_1',
    type: 'scheduled',
    from_address: 'billing@example.com',
    to_address: 'customer@client.dev',
    cc: null,
    bcc: null,
    subject: 'Invoice 42',
    body_text: 'Pay up.',
    body_html: null,
    headers: null,
    labels: '["billing-app"]',
    message_id: '<mail_1@example.com>',
    thread_id: null,
    in_reply_to: null,
    delivery_status: 'queued',
    scheduled_at: '2026-01-01 00:00:00',
    token_id: TOKEN_ID,
    idempotency_key: null,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    provider: null,
    created_at: '2026-01-01 00:00:00',
    raw_size: null,
    is_read: 1,
    is_starred: 0,
    archived: 0,
    provider_message_id: null,
    updated_at: null,
    attachment_count: 0,
    ...overrides,
  };
}

function settingRows(entries = {}) {
  return params => {
    const key = String(params[0]);
    return Object.prototype.hasOwnProperty.call(entries, key) ? { value: entries[key] } : null;
  };
}

/** The API looks tokens up by hash, so the stub has to hash the same way. */
async function responsesFor(token, extra = {}) {
  const hash = await sha256Hex(RAW_TOKEN);
  return {
    'FROM api_tokens WHERE token_hash': { ...token, token_hash: hash },
    'SELECT sent, failed FROM token_usage': null,
    'SELECT * FROM addresses': [{ id: 'a1', address: 'billing@example.com', display_name: 'Billing' }],
    'SELECT value FROM settings WHERE key = ?': settingRows(),
    ...extra,
  };
}

function call(db, path, { method = 'GET', body, token = RAW_TOKEN } = {}) {
  const auth = token === null ? {} : { Authorization: `Bearer ${token}` };
  return v1.request(path, {
    method,
    headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, { DB: db });
}

const sendBody = (overrides = {}) => ({
  from: 'billing@example.com',
  to: 'customer@client.dev',
  subject: 'Invoice 42',
  text: 'Pay up.',
  ...overrides,
});

const noSubject = { to: 'customer@client.dev', text: 'x' };

/** A subscriber row complete enough for listEndpointsForEvent's filtering. */
const webhookEndpoint = (event = 'sent') => ({
  id: 'ep_1',
  url: 'https://example.com/hook',
  secret: 'whsec_test0123456789',
  events: JSON.stringify([event]),
  token_id: null,
  active: 1,
  created_at: '2026-01-01 00:00:00',
  updated_at: null,
});

test('rejects a request with no bearer token', async () => {
  const response = await call(fakeD1(await responsesFor(tokenRow())), '/send', {
    method: 'POST', body: sendBody(), token: null,
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
});

test('rejects an unknown or revoked token without saying which', async () => {
  const response = await call(fakeD1({ 'FROM api_tokens WHERE token_hash': null }), '/send', {
    method: 'POST', body: sendBody(),
  });

  assert.equal(response.status, 401);
  assert.match((await response.json()).message, /Unknown or revoked/);
});

test('a token without the send scope cannot post mail', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ scopes: '["status"]' })));
  const response = await call(db, '/send', { method: 'POST', body: sendBody() });

  assert.equal(response.status, 403);
  assert.match((await response.json()).message, /"send" scope/);
});

test('a malformed scopes column degrades to no scopes, not full access', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ scopes: 'not json' })));
  assert.equal((await call(db, '/send', { method: 'POST', body: sendBody() })).status, 403);
});

test('the per-minute token limit returns 429 with a retry hint', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ rate_per_min: 2 })));

  // Validation happens after the limiter, so even rejected bodies consume budget.
  assert.equal((await call(db, '/send', { method: 'POST', body: noSubject })).status, 400);
  assert.equal((await call(db, '/send', { method: 'POST', body: noSubject })).status, 400);
  const third = await call(db, '/send', { method: 'POST', body: noSubject });

  assert.equal(third.status, 429);
  const body = await third.json();
  assert.equal(body.error, 'rate_limited');
  assert.match(body.message, /2 requests per minute/);
  assert.ok(body.retry_after > 0);
});

test('an exhausted daily budget is refused before any relay is touched', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ daily_budget: 10 }), {
    'SELECT sent, failed FROM token_usage': { sent: 7, failed: 3 },
  }));

  const response = await call(db, '/send', { method: 'POST', body: sendBody() });

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'budget_exceeded');
  assert.equal(writesMatching(db, 'INSERT INTO emails').length, 0);
});

test('validation problems are 400 and never reach the queue', async () => {
  const cases = [
    [{ to: '' }, /to is required/],
    [{ to: 'not-an-email' }, /Invalid to/],
    [{ to: Array.from({ length: 51 }, (_, i) => `u${i}@x.com`) }, /exceeds 50 recipients/],
    [{ subject: '' }, /subject is required/],
    [{ subject: 'x'.repeat(999) }, /subject exceeds 998/],
    [{ text: '', html: '' }, /body is required/],
    [{ text: 'x'.repeat(1_000_001) }, /text body exceeds 1MB/],
    [{ send_at: 'yesterday' }, /send_at is not a valid ISO datetime/],
  ];

  for (const [overrides, pattern] of cases) {
    const db = fakeD1(await responsesFor(tokenRow()));
    const response = await call(db, '/send', { method: 'POST', body: sendBody(overrides) });

    assert.equal(response.status, 400, JSON.stringify(overrides).slice(0, 80));
    assert.match((await response.json()).message, pattern);
    assert.equal(writesMatching(db, 'INSERT INTO emails').length, 0, `${pattern} must not queue mail`);
  }
});

test('a body that is not JSON at all is a 400, not a 500', async () => {
  const db = fakeD1(await responsesFor(tokenRow()));
  const response = await v1.request('/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RAW_TOKEN}`, 'Content-Type': 'application/json' },
    body: '{"to":',
  }, { DB: db });

  assert.equal(response.status, 400);
});

test('callers may not set envelope headers or inject line breaks', async () => {
  const payloads = [
    { headers: { From: 'attacker@evil.dev' } },
    { headers: { 'Message-Id': '<fake>' } },
    { headers: { 'Content-Type': 'text/html' } },
    { headers: { 'Dkim-Signature': 'v=1' } },
    { headers: { 'X-Trace': 'ok\r\nBcc: attacker@evil.dev' } },
    { headers: { 'X-Trace': 'ok\nBcc: attacker@evil.dev' } },
    { headers: { 'X-Trace': 'ok\rBcc: attacker@evil.dev' } },
    { headers: { 'Disposition-Notification-To': 'attacker@evil.dev' } },
    { headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-K${i}`, 'v'])) },
  ];

  for (const payload of payloads) {
    const db = fakeD1(await responsesFor(tokenRow()));
    const response = await call(db, '/send', { method: 'POST', body: sendBody(payload) });
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
});

test('custom X- headers and Reply-To survive validation', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT * FROM emails WHERE id = ?': storedEmail(),
  }));

  const response = await call(db, '/send', {
    method: 'POST',
    body: sendBody({ headers: { 'X-Invoice-Id': '42', 'Reply-To': 'replies@example.com' } }),
  });

  assert.equal(response.status, 202);
  const insert = writesMatching(db, 'INSERT INTO emails').at(-1);
  const headersCell = insert.params.find(value => typeof value === 'string' && value.includes('X-Invoice-Id'));
  assert.ok(headersCell.includes('Reply-To'), 'Reply-To must reach the relay');
});

test('a token pinned to an identity cannot send as anybody else', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ identity_address: 'billing@example.com' })));

  const spoof = await call(db, '/send', { method: 'POST', body: sendBody({ from: 'ceo@example.com' }) });
  assert.equal(spoof.status, 403);
  assert.equal((await spoof.json()).error, 'identity_mismatch');
});

test('an unpinned token may only send from a configured address', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), { 'SELECT * FROM addresses': [] }));
  const response = await call(db, '/send', { method: 'POST', body: sendBody({ from: 'spoof@other.com' }) });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'unverified_sender');
});

test('a known From address, or a pinned identity, is accepted', async () => {
  for (const [token, addresses] of [
    [tokenRow(), [{ id: 'a1', address: 'billing@example.com', display_name: 'Billing' }]],
    [tokenRow({ identity_address: 'billing@example.com' }), []],
  ]) {
    const db = fakeD1(await responsesFor(token, {
      'SELECT * FROM addresses': addresses,
      'SELECT * FROM emails WHERE id = ?': storedEmail(),
    }));
    const response = await call(db, '/send', { method: 'POST', body: sendBody({ from: addresses.length ? 'Billing <billing@example.com>' : undefined }) });

    assert.equal(response.status, 202, addresses.length ? 'known address' : 'pinned identity');
    assert.equal(writesMatching(db, 'INSERT INTO emails').length, 1);
  }
});

test('a replayed idempotency key returns the original message instead of sending twice', async () => {
  const seen = storedEmail({ idempotency_key: 'inv-42', delivery_status: 'delivered' });
  const db = fakeD1(await responsesFor(tokenRow(), {
    'AND idempotency_key = ? LIMIT 1': seen,
  }));

  const response = await call(db, '/send', { method: 'POST', body: sendBody({ idempotency_key: 'inv-42' }) });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.deduplicated, true);
  assert.equal(body.id, 'mail_1');
  assert.equal(writesMatching(db, 'INSERT INTO emails').length, 0);
});

test('a future send_at is stored for the cron instead of going out now', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT * FROM emails WHERE id = ?': storedEmail(),
  }));

  const response = await call(db, '/send', {
    method: 'POST',
    body: sendBody({ send_at: new Date(Date.now() + 3600_000).toISOString() }),
  });

  assert.equal(response.status, 202);
  assert.ok((await response.json()).queued_for);
  assert.equal(writesMatching(db, 'UPDATE emails SET').length, 0, 'a future send must not attempt delivery');
});

test('a send_at in the past is refused', async () => {
  const db = fakeD1(await responsesFor(tokenRow()));
  const response = await call(db, '/send', {
    method: 'POST',
    body: sendBody({ send_at: new Date(Date.now() - 3600_000).toISOString() }),
  });

  assert.equal(response.status, 400);
});

test('with no relay configured the mail stays queued and the caller is told it will retry', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT * FROM emails WHERE id = ?': storedEmail(),
  }));

  const response = await call(db, '/send', { method: 'POST', body: sendBody() });
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(body.status, 'queued');
  assert.equal(body.retrying, true);
  assert.match(body.reason, /No sending provider is configured/);

  const queueUpdate = writesMatching(db, 'UPDATE emails SET').at(-1);
  assert.ok(queueUpdate, 'the row must be written back with retry state');
  assert.ok(queueUpdate.params.includes('queued'));
  assert.ok(writesMatching(db, 'SET last_used_at').length >= 1, 'token activity must be recorded');
});

test('a message the relay rejects outright is a 422 and is not retried', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT value FROM settings WHERE key = ?': settingRows({ provider_key_brevo: 'xkeysib-1' }),
    'SELECT * FROM emails WHERE id = ?': storedEmail(),
    'FROM webhook_endpoints': [webhookEndpoint('failed')],
  }));

  globalThis.fetch = async (url) => {
    if (String(url).includes('api.brevo.com')) return Response.json({ message: 'sender is not verified' }, { status: 400 });
    return Response.error();
  };
  try {
    const response = await call(db, '/send', { method: 'POST', body: sendBody() });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.error, 'rejected_by_relay');
    assert.match(body.detail, /sender is not verified/);

    const queueUpdate = writesMatching(db, 'UPDATE emails SET').at(-1);
    assert.ok(queueUpdate.params.includes('failed'), 'permanent rejection must kill the row');
    assert.equal(queueUpdate.params.includes(null), true, 'no next attempt is scheduled');
    assert.ok(writesMatching(db, 'INTO token_usage').length >= 1, 'the failure counts against the token budget');

    const delivery = writesMatching(db, 'INSERT INTO webhook_deliveries').at(-1);
    assert.ok(delivery, 'subscribers must be told the send failed');
    assert.equal(JSON.parse(delivery.params[3]).type, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a successful in-request send is queued for webhook delivery, not only answered', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT value FROM settings WHERE key = ?': settingRows({ provider_key_brevo: 'xkeysib-1' }),
    'SELECT * FROM emails WHERE id = ?': storedEmail(),
    'FROM webhook_endpoints': [webhookEndpoint('sent')],
  }));

  globalThis.fetch = async () => Response.json({ messageId: '<invoice-42@example.com>' });
  try {
    const response = await call(db, '/send', { method: 'POST', body: sendBody() });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'sent');
    assert.equal(body.provider, 'brevo');
    assert.equal(body.provider_message_id, '<invoice-42@example.com>');

    const delivery = writesMatching(db, 'INSERT INTO webhook_deliveries').at(-1);
    assert.ok(delivery, 'subscribers must be told about the send');
    const payload = JSON.parse(delivery.params[3]);
    assert.equal(payload.type, 'sent');
    assert.equal(payload.data.token_id, TOKEN_ID);
    assert.equal(payload.data.provider_message_id, '<invoice-42@example.com>');
    assert.ok(writesMatching(db, 'INSERT INTO contacts').length >= 1, 'recipients become contacts');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('message lists are scoped to the calling token and omit bodies', async () => {
  const db = fakeD1(await responsesFor(tokenRow(), {
    'FROM emails WHERE token_id = ?': [storedEmail()],
  }));

  const response = await call(db, '/messages');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].direction, 'outbound');
  assert.equal(body.messages[0].body_text, undefined);
  assert.equal(body.messages[0].text, undefined);
});

test('inbound mail requires the read scope', async () => {
  const sendOnly = fakeD1(await responsesFor(tokenRow({ scopes: '["send"]' })));
  assert.equal((await call(sendOnly, '/messages?direction=inbound')).status, 403);

  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT emails.*': [storedEmail({ type: 'received', id: 'in_1', token_id: null })],
  }));
  const ok = await call(db, '/messages?direction=inbound');

  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).messages[0].direction, 'inbound');
});

test('another token\'s message id looks like it does not exist', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ scopes: '["send"]' }), {
    'SELECT * FROM emails WHERE id = ?': storedEmail({ token_id: 'tok_other' }),
  }));

  assert.equal((await call(db, '/messages/mail_1')).status, 404);
});

test('read scope exposes inbound bodies and attachments', async () => {
  const inbound = storedEmail({ type: 'received', id: 'in_1', token_id: null, body_text: 'hello' });
  const db = fakeD1(await responsesFor(tokenRow(), {
    'SELECT * FROM emails WHERE id = ?': inbound,
    'SELECT id, email_id, filename, content_type, size, r2_key, created_at FROM attachments WHERE email_id = ?': [
      { id: 'att_1', filename: 'bill.pdf', content_type: 'application/pdf', size: 1234 },
    ],
  }));

  const response = await call(db, '/messages/in_1');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.text, 'hello');
  assert.deepEqual(body.attachments, [{ id: 'att_1', filename: 'bill.pdf', content_type: 'application/pdf', size: 1234 }]);
});

test('quota reports relay capacity and this token\'s remaining budget', async () => {
  const db = fakeD1(await responsesFor(tokenRow({ scopes: '["status"]' }), {
    'SELECT sent, failed FROM token_usage': { sent: 3, failed: 1 },
    'SELECT value FROM settings WHERE key = ?': settingRows({ provider_key_brevo: 'xkeysib-1' }),
  }));

  const response = await call(db, '/quota');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.token.name, 'billing-app');
  assert.equal(body.token.sent_today, 3);
  assert.equal(body.token.remaining_today, 496);
  assert.equal(body.providers.length, 1, 'unconfigured relays are not reported');
  assert.equal(body.providers[0].id, 'brevo');
  assert.equal(body.providers[0].quota_day, 300);
  assert.equal(body.total_remaining_today, 300);
});

test('whoami describes the token without revealing the secret', async () => {
  const db = fakeD1(await responsesFor(tokenRow()));
  const response = await call(db, '/whoami');
  const body = await response.json();
  const text = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.deepEqual(body.scopes, ['send', 'status', 'read']);
  assert.equal(text.includes(RAW_TOKEN), false);
  assert.equal(text.includes(await sha256Hex(RAW_TOKEN)), false);
});
