/**
 * The queue claim is the one place where two cron drains can both believe they
 * own a message, so it is tested against the real SQL on real SQLite rather
 * than the substring stub used elsewhere. `emails` and `webhook_deliveries` are
 * created from schema.sql itself, so a renamed column cannot quietly desync the
 * statement from the table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import './ts-hooks.mjs';

const { DatabaseQueries } = await import('../src/db/queries.ts');
const { DRAIN_LEASE_SECONDS } = await import('../src/lib/backoff.ts');

const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

function tableDdl(name) {
  const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
  if (!match) throw new Error(`${name} is missing from schema.sql`);
  return match[0];
}

/** D1's statement surface over an in-memory SQLite database. */
function sqliteAsD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(tableDdl('emails'));
  sqlite.exec(tableDdl('webhook_deliveries'));

  return {
    exec(sql) { sqlite.exec(sql); },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      return {
        bind(...values) {
          params = values;
          return this;
        },
        async all() { return { results: statement.all(...params) }; },
        async first() { return statement.get(...params) ?? null; },
        async run() {
          const result = statement.run(...params);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    },
  };
}

function queueDb() {
  const db = sqliteAsD1();
  return { db: new DatabaseQueries(db), raw: db };
}

function insertQueued(raw, id, overrides = {}) {
  const row = {
    type: 'scheduled',
    delivery_status: 'queued',
    scheduled_at: "datetime('now')",
    next_attempt_at: 'NULL',
    ...overrides,
  };
  raw.exec(
    `INSERT INTO emails (id, type, from_address, to_address, subject, delivery_status, scheduled_at, next_attempt_at)
     VALUES ('${id}', '${row.type}', 'me@example.com', 'you@example.com', 'hi', ${quote(row.delivery_status)}, ${row.scheduled_at}, ${row.next_attempt_at})`
  );
}

function quote(value) {
  return value === null ? 'NULL' : `'${value}'`;
}

test('a due row is claimed once and a second drain loses', async () => {
  const { db, raw } = queueDb();
  insertQueued(raw, 'mail_1');

  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), true);
  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), false);
  assert.deepEqual(await db.listDueQueueEmails(20), [], 'a leased row is not due');
});

test('an expired lease puts the row back on the queue', async () => {
  const { db, raw } = queueDb();
  insertQueued(raw, 'mail_1');
  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), true);

  // Simulate the drain dying: the lease ages out without any other writer.
  raw.exec("UPDATE emails SET next_attempt_at = datetime('now', '-1 minute') WHERE id = 'mail_1'");

  assert.equal((await db.listDueQueueEmails(20)).length, 1);
  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), true);
});

test("mail that is not this drain's work is never claimed", async () => {
  const { db, raw } = queueDb();

  insertQueued(raw, 'delivered', { delivery_status: 'delivered' });
  insertQueued(raw, 'failed', { delivery_status: 'failed' });
  insertQueued(raw, 'later', { scheduled_at: "datetime('now', '+1 hour')" });
  insertQueued(raw, 'sent', { type: 'sent' });
  insertQueued(raw, 'waiting', { next_attempt_at: "datetime('now', '+10 minutes')" });

  for (const id of ['delivered', 'failed', 'later', 'sent', 'waiting', 'absent']) {
    assert.equal(await db.claimQueueEmail(id, DRAIN_LEASE_SECONDS), false, `${id} must not be claimable`);
  }
});

test('a delivered or abandoned row leaves the queue for good', async () => {
  const { db, raw } = queueDb();
  insertQueued(raw, 'mail_1');

  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), true);
  await db.markEmailSent('mail_1', 'relay-id-1', 'brevo');
  raw.exec("UPDATE emails SET next_attempt_at = datetime('now', '-1 second') WHERE id = 'mail_1'");

  assert.deepEqual(await db.listDueQueueEmails(20), []);
  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), false);

  await db.updateEmailQueueFields('mail_1', {
    delivery_status: 'failed',
    attempts: 10,
    next_attempt_at: null,
    last_error: 'relay said no',
    provider: null,
  });
  assert.equal(await db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS), false);
});

test('two claims in flight race for the same row and only one wins', async () => {
  const { db, raw } = queueDb();
  insertQueued(raw, 'mail_1');

  const results = await Promise.all([
    db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS),
    db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS),
    db.claimQueueEmail('mail_1', DRAIN_LEASE_SECONDS),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

test('pending webhook deliveries are claimed the same way', async () => {
  const { db, raw } = queueDb();
  raw.exec("INSERT INTO webhook_deliveries (id, endpoint_id, event, payload) VALUES ('del_1', 'ep_1', 'sent', '{\"a\":1}')");

  assert.equal(await db.claimWebhookDelivery('del_1', DRAIN_LEASE_SECONDS), true);
  assert.equal(await db.claimWebhookDelivery('del_1', DRAIN_LEASE_SECONDS), false);

  raw.exec("UPDATE webhook_deliveries SET next_attempt_at = datetime('now', '-1 minute') WHERE id = 'del_1'");
  assert.equal((await db.listDueWebhookDeliveries(25)).length, 1);
  assert.equal(await db.claimWebhookDelivery('del_1', DRAIN_LEASE_SECONDS), true);

  await db.markWebhookDelivered('del_1');
  raw.exec("UPDATE webhook_deliveries SET next_attempt_at = datetime('now', '-1 minute') WHERE id = 'del_1'");
  assert.equal(await db.claimWebhookDelivery('del_1', DRAIN_LEASE_SECONDS), false);
  assert.equal((await db.listDueWebhookDeliveries(25)).length, 0);
});
