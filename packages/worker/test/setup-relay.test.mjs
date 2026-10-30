import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ts-hooks.mjs';
import { fakeD1, writesMatching } from './d1-stub.mjs';

const setup = (await import('../src/api/setup.ts')).default;
const providers = (await import('../src/api/providers.ts')).default;

const originalFetch = globalThis.fetch;

/** Settings rows plus the usage lookup every provider status read performs. */
function dbWithSettings(settings) {
  return fakeD1({
    'FROM settings WHERE key = ?': ([key]) => (settings[key] === undefined ? null : { value: settings[key] }),
    'SELECT key, value FROM settings': Object.entries(settings).map(([key, value]) => ({ key, value })),
    'FROM provider_usage': { count: 0 },
  });
}

/** True when the settings upsert ran for that key (the key is a bind param, not SQL text). */
function settingWritten(db, key) {
  return writesMatching(db, 'INSERT INTO settings').some(write => write.params[0] === key);
}

/** Answers the Brevo endpoints the relay screens touch: key check + webhooks. */
function stubBrevo(calls) {  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = options.method ?? 'GET';
    calls.push({ href, method, body: options.body });

    if (href.includes('/webhooks') && method === 'POST') return Response.json({ id: 9 });
    if (href.includes('/webhooks')) return Response.json({ webhooks: [] });
    return Response.json({});
  };
}

test('finishing setup only asks for a relay, any relay', async () => {
  const db = dbWithSettings({
    cloudflare_api_key: 'cf',
    cloudflare_account_id: 'acct',
    cloudflare_zone_id: 'zone',
    domain: 'example.com',
    provider_key_resend: 're_test_resendkey',
  });

  const response = await setup.request('/complete', { method: 'POST' }, { DB: db });

  assert.equal(response.status, 200);
  assert.ok(settingWritten(db, 'setup_completed'), 'completion must be recorded');
});

test('a database with no relay is told what is missing', async () => {
  const db = dbWithSettings({
    cloudflare_api_key: 'cf',
    cloudflare_account_id: 'acct',
    cloudflare_zone_id: 'zone',
    domain: 'example.com',
  });

  const response = await setup.request('/complete', { method: 'POST' }, { DB: db });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body.missing, ['A sending relay']);
});

test('setup status names the relays that are connected', async () => {
  const db = dbWithSettings({
    cloudflare_api_key: 'cf',
    cloudflare_account_id: 'acct',
    cloudflare_zone_id: 'zone',
    domain: 'example.com',
    provider_key_brevo: 'xkeysib-legacy',
    provider_key_resend: 're_test_resendkey',
  });

  const body = await (await setup.request('/status', {}, { DB: db })).json();

  assert.equal(body.relays.configured, true);
  assert.deepEqual(body.relays.connected.map(relay => relay.id).sort(), ['brevo', 'resend']);
  assert.equal(body.cloudflare.configured, true);
});

test('saving a Brevo key from the mail-server screen registers delivery tracking', async () => {
  const calls = [];
  stubBrevo(calls);
  const db = dbWithSettings({});

  try {
    const response = await providers.request('/brevo/key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'xkeysib-a-key' }),
    }, { DB: db });
    assert.equal(response.status, 200);

    const created = calls.find(call => call.method === 'POST' && call.href.includes('/webhooks'));
    assert.ok(created, 'the webhook must be registered');
    const url = JSON.parse(created.body).url;
    assert.match(url, /^https?:\/\/[^/]+\/api\/webhooks\/brevo\/[a-f0-9]{48}$/);

    assert.ok(settingWritten(db, 'provider_key_brevo'), 'the new key must be stored');
    assert.ok(writesMatching(db, 'DELETE FROM settings WHERE key = ?')
      .some(write => write.params[0] === 'brevo_api_key'), 'the legacy key must not shadow it');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a key the relay rejects is never stored', async () => {
  globalThis.fetch = async () => new Response('{"code":"invalid_key"}', { status: 401 });
  const db = dbWithSettings({});

  try {
    const response = await providers.request('/brevo/key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'xkeysib-bad' }),
    }, { DB: db });

    assert.equal(response.status, 400);
    assert.equal(writesMatching(db, 'INSERT INTO settings').length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
