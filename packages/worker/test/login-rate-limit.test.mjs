/**
 * The login limiter is the only thing between a stranger and the mailbox, and
 * `clearOnSuccess` is the only thing between the owner and their own lockout.
 * Both are asserted through the mounted router, so the middleware chain, the
 * D1 window bookkeeping and the route all have to agree for these to pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ts-hooks.mjs';
import { fakeD1, writesMatching } from './d1-stub.mjs';

const api = (await import('../src/api/routes.ts')).default;
const { hashPassword } = await import('../src/lib/utils.ts');

const password = 'a long memorable passphrase';

async function legacyHash(value) {
  const salt = 'deadbeef';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + value));
  return `${salt}:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function loginDb(storedHash) {
  return fakeD1({
    'FROM settings WHERE key = ?': ([key]) => (key === 'admin_password_hash' ? { value: storedHash } : null),
  });
}

function login(db, value) {
  return api.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: value }),
  }, { DB: db });
}

/** The limiter's window cleanup uses the same table with two params; a reset uses one. */
function resets(db) {
  return writesMatching(db, 'DELETE FROM rate_limits').filter(write => write.params.length === 1);
}

test('a failed login is counted and its budget is kept', async () => {
  const db = loginDb(await hashPassword(password));

  assert.equal((await login(db, 'wrong-one')).status, 401);
  assert.equal(writesMatching(db, 'INSERT INTO rate_limits').length, 1);
  assert.deepEqual(resets(db), []);
});

test('a successful login clears the attempts before it', async () => {
  const db = loginDb(await hashPassword(password));

  await login(db, 'wrong-one');
  await login(db, 'wrong-two');
  const response = await login(db, password);

  assert.equal(response.status, 200);
  assert.ok((await response.json()).token, 'a session must be issued');
  assert.deepEqual(resets(db).map(write => write.params), [['login:unknown']]);
});

test('six correct logins in a row never hit the ceiling', async () => {
  const db = loginDb(await hashPassword(password));

  for (let attempt = 1; attempt <= 6; attempt++) {
    assert.equal(await (await login(db, password)).status, 200, `attempt ${attempt}`);
  }
});

test('six wrong logins are locked after the fifth', async () => {
  const db = loginDb(await hashPassword(password));

  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal((await login(db, 'nope')).status, 401, `attempt ${attempt}`);
  }

  const blocked = await login(db, 'nope');
  assert.equal(blocked.status, 429);
  assert.deepEqual(resets(db), [], 'a locked guess must not clear the budget');
});

test('a legacy password hash is upgraded on the first good login', async () => {
  const db = loginDb(await legacyHash(password));

  assert.equal((await login(db, password)).status, 200);

  const upgraded = writesMatching(db, 'INSERT INTO settings')
    .find(write => write.params[0] === 'admin_password_hash');
  assert.ok(upgraded, 'the rehashed password must be stored');
  assert.match(upgraded.params[1], /^pbkdf2:100000:/);
});

test('a wrong password never rewrites the stored hash', async () => {
  const db = loginDb(await legacyHash(password));

  assert.equal((await login(db, 'guess')).status, 401);
  assert.deepEqual(writesMatching(db, 'INSERT INTO settings'), []);
});
