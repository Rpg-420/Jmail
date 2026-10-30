import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './ts-hooks.mjs';

const {
  sendThroughProviders,
  listProviderStatuses,
  currentDayPeriod,
  currentMonthPeriod,
} = await import('../src/lib/providers/index.ts');
const { PermanentSendError, QuotaExhaustedError, TransientSendError } = await import('../src/lib/providers/types.ts');

/** Minimal stand-in for DatabaseQueries: only the settings + ledger calls the provider layer makes. */
function fakeDb({ settings = {}, usage = {} } = {}) {
  const record = [];
  return {
    record,
    used: usage,
    async getSetting(key) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
    },
    async getProviderUsage(id, kind, period) {
      return usage[`${id}:${kind}:${period}`] ?? 0;
    },
    async recordProviderUsage(id, kind, period) {
      const key = `${id}:${kind}:${period}`;
      usage[key] = (usage[key] ?? 0) + 1;
      record.push(key);
    },
  };
}

const message = (overrides = {}) => ({
  from: { email: 'bot@example.com' },
  to: [{ email: 'someone@other.dev' }],
  subject: 'hi',
  text: 'body',
  ...overrides,
});

const originalFetch = globalThis.fetch;

// Nothing in this suite may reach the internet: an unstubbed call fails loudly.
beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error('test attempted a real network call');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return handler(String(url), calls.length);
  };
  return calls;
}

const okBrevo = () => Response.json({ messageId: '<abc@example.brevo>' });
const okResend = () => Response.json({ id: 'resend-1' });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('uses the first configured relay and records quota on both ledgers', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1', provider_key_resend: 're_1' } });
  const calls = respondWith(url => (url.includes('brevo') ? okBrevo() : okResend()));

  const outcome = await sendThroughProviders(db, message());

  assert.equal(outcome.provider, 'brevo');
  assert.equal(outcome.providerMessageId, '<abc@example.brevo>');
  assert.equal(calls.length, 1);
  assert.deepEqual(db.record, [
    `brevo:day:${currentDayPeriod()}`,
    `brevo:month:${currentMonthPeriod()}`,
  ]);
});

test('reads the legacy brevo_api_key setting so old installs keep sending', async () => {
  const db = fakeDb({ settings: { brevo_api_key: 'xkeysib-old' } });
  const calls = respondWith(okBrevo);

  assert.equal((await sendThroughProviders(db, message())).provider, 'brevo');
  assert.equal(calls.length, 1);
});

test('honours the admin-defined failover order', async () => {
  const db = fakeDb({
    settings: { provider_key_brevo: 'xkeysib-1', provider_key_resend: 're_1', provider_order: '["resend","brevo"]' },
  });
  const calls = respondWith(url => (url.includes('resend') ? okResend() : okBrevo()));

  assert.equal((await sendThroughProviders(db, message())).provider, 'resend');
  assert.equal(calls[0].url.includes('resend'), true);
});

test('fails over when the first relay rejects the sender permanently', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1', provider_key_resend: 're_1' } });
  const calls = respondWith(url =>
    url.includes('brevo') ? Response.json({ message: 'sender domain not validated' }, { status: 400 }) : okResend()
  );

  const outcome = await sendThroughProviders(db, message());
  assert.equal(outcome.provider, 'resend');
  assert.equal(calls.length, 2);
});

test('a relay at its daily cap is skipped without burning the other quota', async () => {
  const usage = { [`brevo:day:${currentDayPeriod()}`]: 300 };
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1', provider_key_resend: 're_1' }, usage });
  const calls = respondWith(url => (url.includes('resend') ? okResend() : okBrevo()));

  assert.equal((await sendThroughProviders(db, message())).provider, 'resend');
  assert.equal(calls.some(call => call.url.includes('brevo')), false);
});

test('a relay at its monthly cap is skipped too', async () => {
  const db = fakeDb({
    settings: { provider_key_brevo: 'xkeysib-1', provider_key_resend: 're_1', provider_quota_brevo_month: '5000' },
    usage: { [`brevo:month:${currentMonthPeriod()}`]: 5000 },
  });
  respondWith(url => (url.includes('resend') ? okResend() : okBrevo()));

  assert.equal((await sendThroughProviders(db, message())).provider, 'resend');
});

test('every relay at quota defers the mail instead of losing it', async () => {
  const usage = {
    [`brevo:day:${currentDayPeriod()}`]: 300,
    [`resend:day:${currentDayPeriod()}`]: 100,
  };
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1', provider_key_resend: 're_1' }, usage });

  await assert.rejects(
    () => sendThroughProviders(db, message()),
    error => error instanceof QuotaExhaustedError
  );
});

test('too many recipients is permanent, never queued for retry', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1' } });
  const to = Array.from({ length: 51 }, (_, i) => ({ email: `user${i}@example.com` }));

  await assert.rejects(
    () => sendThroughProviders(db, message({ to })),
    error => error instanceof PermanentSendError && /recipients/.test(error.message)
  );
});

test('an oversized message is rejected before any relay sees it', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1' } });
  const calls = respondWith(okBrevo);
  // 30MB of base64 ≈ 22MB of payload, over brevo's 19MB cap
  const content = 'A'.repeat(30 * 1024 * 1024);

  await assert.rejects(
    () => sendThroughProviders(db, message({ attachments: [{ filename: 'big.bin', content }] })),
    error => error instanceof PermanentSendError && /size limit/.test(error.message)
  );
  assert.equal(calls.length, 0);
});

test('a relay that is down leaves the message transient so the queue retries', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1' } });
  respondWith(() => Response.json({ message: 'upstream timeout' }, { status: 503 }));

  await assert.rejects(
    () => sendThroughProviders(db, message()),
    error => error instanceof TransientSendError && /brevo 503/.test(error.message)
  );
});

test('a 429 from a relay is treated as transient, not a dead message', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1' } });
  respondWith(() => Response.json({ message: 'too many requests' }, { status: 429 }));

  await assert.rejects(
    () => sendThroughProviders(db, message()),
    error => error instanceof TransientSendError
  );
});

test('with no relay configured the failure is transient, not permanent', async () => {
  await assert.rejects(
    () => sendThroughProviders(fakeDb(), message()),
    error => error instanceof TransientSendError && /No sending provider is configured/.test(error.message)
  );
});

test('statuses expose remaining capacity and never leak the key', async () => {
  const db = fakeDb({
    settings: { provider_key_brevo: 'xkeysib-1', provider_quota_brevo_day: '300' },
    usage: { [`brevo:day:${currentDayPeriod()}`]: 120 },
  });

  const statuses = await listProviderStatuses(db);
  const brevo = statuses.find(status => status.id === 'brevo');

  assert.equal(brevo.configured, true);
  assert.equal(brevo.remaining, 180);
  assert.equal(brevo.usedDay, 120);
  assert.equal(brevo.maxRecipients, 50);
  assert.equal(statuses.find(status => status.id === 'resend').configured, false);
  assert.equal(JSON.stringify(statuses).includes('xkeysib-1'), false);
});

test('an explicit daily quota overrides the relay free-plan default', async () => {
  const db = fakeDb({ settings: { provider_key_brevo: 'xkeysib-1', provider_quota_brevo_day: '50' } });
  const brevo = (await listProviderStatuses(db)).find(status => status.id === 'brevo');

  assert.equal(brevo.quotaDay, 50);
  assert.equal(brevo.remaining, 50);
});
