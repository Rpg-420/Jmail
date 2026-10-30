/**
 * Inbound mail is untrusted input arriving in bulk: a single spam run with a
 * 4 MB header block or a million-line body must not be able to fill the 5 GB D1
 * budget. These checks run the real parser over a real message and assert on
 * what actually reaches the database — including that the parts which were kept
 * are still intact (Cc in particular, which an earlier version wiped while
 * annotating the dropped attachments).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ts-hooks.mjs';
import { fakeD1, writesMatching } from './d1-stub.mjs';

const { handleEmail, MAX_INBOUND_TEXT_BYTES, MAX_INBOUND_HTML_BYTES, MAX_INBOUND_SUBJECT_LENGTH, MAX_INBOUND_ATTACHMENTS } =
  await import('../src/email-handler.ts');

/** Bind order of DatabaseQueries.createEmail — the first columns are what matters here. */
const CREATE_COLUMNS = ['id', 'type', 'from_address', 'to_address', 'cc', 'bcc', 'subject', 'body_text', 'body_html', 'headers'];
const UPDATE_COLUMNS = ['from_address', 'to_address', 'cc', 'bcc', 'subject', 'body_text', 'body_html', 'scheduled_at', 'id'];

function keyed(columnNames, params) {
  return Object.fromEntries(columnNames.map((name, index) => [name, params[index]]));
}

function storedEmail(db) {
  return keyed(CREATE_COLUMNS, writesMatching(db, 'INSERT INTO emails')[0].params);
}

function rewritten(db) {
  const write = writesMatching(db, 'UPDATE emails SET from_address = ?')[0];
  return write ? keyed(UPDATE_COLUMNS, write.params) : null;
}

function rawMessage(body) {
  return {
    from: 'sender@example.com',
    to: 'me@example.com',
    raw: new TextEncoder().encode(body),
    headers: new Headers(),
    accept: () => {},
    forward: () => {},
  };
}

function message({ subject = 'A normal subject', text = 'Plain body.', html = '<p>Html body.</p>', extraHeaders = [], cc = 'cc@example.com', attachments = [] }) {
  // text and html are alternatives of one body; attachments sit at the mixed
  // level, exactly as a real client sends them.
  const body = [
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '--ALT--',
  ];

  const parts = [
    'From: sender@example.com',
    'To: me@example.com',
    `Cc: ${cc}`,
    `Subject: ${subject}`,
    'Message-ID: <inbound-1@example.com>',
    'Date: Wed, 29 Oct 2026 10:00:00 +0000',
    ...extraHeaders,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    ...body,
    ...attachments.flatMap(name => [
      '--BOUND',
      `Content-Type: application/octet-stream; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8gd29ybGQ=',
    ]),
    '--BOUND--',
    '',
  ];
  return rawMessage(parts.join('\r\n'));
}

test('an oversized subject, body and header block are clamped, not rejected', async () => {
  const db = fakeD1();
  const huge = 'x'.repeat(MAX_INBOUND_TEXT_BYTES + 50_000);
  const wide = 'y'.repeat(MAX_INBOUND_SUBJECT_LENGTH + 500);
  const extraHeaders = Array.from({ length: 4000 }, (_, i) => `X-Trace-${i}: ${'z'.repeat(60)}`);

  await handleEmail(message({ subject: wide, text: huge, extraHeaders }), { DB: db });

  const stored = storedEmail(db);
  assert.ok(stored.subject.startsWith('y'.repeat(MAX_INBOUND_SUBJECT_LENGTH)), 'subject keeps its head');
  assert.match(stored.subject, /truncated at the storage limit/, 'the clamp is labelled');
  assert.ok(stored.body_text.startsWith('x'.repeat(MAX_INBOUND_TEXT_BYTES)), 'text keeps its head');
  assert.ok(stored.body_text.length < MAX_INBOUND_TEXT_BYTES + 200, 'text is bounded');
  assert.equal(stored.body_html, '<p>Html body.</p>\n', 'the part that fits is untouched');

  const headers = JSON.parse(stored.headers);
  assert.ok(Array.isArray(headers), 'headers stay the array the UI reads');
  const names = headers.map(header => header.key);
  assert.ok(names.includes('from') && names.includes('subject'), 'useful headers survive');
  assert.ok(names.includes('x-jmail-truncated-headers'), 'the drop is recorded');
  assert.ok(headers.every(header => typeof header.value === 'string'), 'no header loses its value');
  assert.ok(JSON.stringify(headers).length < 4000, 'the stored header block is small again');
});

test('a huge HTML part is clamped too', async () => {
  const db = fakeD1();

  await handleEmail(message({ html: '<b>'.repeat(MAX_INBOUND_HTML_BYTES) }), { DB: db });

  const bodyHtml = storedEmail(db).body_html;
  assert.ok(bodyHtml.length < MAX_INBOUND_HTML_BYTES + 200);
  assert.match(bodyHtml, /truncated at the storage limit/);
});

test('files over the attachment count are named in the message and the Cc survives', async () => {
  const db = fakeD1();
  const files = Array.from({ length: MAX_INBOUND_ATTACHMENTS + 3 }, (_, i) => `part-${i}.bin`);

  await handleEmail(message({ attachments: files, text: 'short body' }), { DB: db });

  assert.equal(writesMatching(db, 'INSERT INTO attachments').length, MAX_INBOUND_ATTACHMENTS);

  const update = rewritten(db);
  assert.ok(update, 'the note is written back to the stored row');
  assert.equal(update.from_address, 'sender@example.com');
  assert.equal(update.to_address, 'me@example.com');
  assert.equal(update.cc, 'cc@example.com', 'annotating must not drop the Cc');
  assert.match(update.body_text, /over the file count limit/, 'the reader is told which files went missing');
  assert.match(update.body_text, /part-25\.bin|part-26\.bin/);
  assert.match(update.body_html, /<hr>Attachments too large/, 'the HTML part carries the note as well');
});

test('a message that fits is stored exactly as it arrived', async () => {
  const db = fakeD1();

  await handleEmail(message({ text: 'nothing unusual here' }), { DB: db });

  const stored = storedEmail(db);
  assert.equal(stored.body_text, 'nothing unusual here\n', 'the whole part is stored');
  assert.equal(stored.body_html, '<p>Html body.</p>\n');
  assert.equal(rewritten(db), null, 'no rewrite when nothing was dropped');
});

test('a message the parser refuses is kept for inspection instead of retried forever', async () => {
  const db = fakeD1();
  // postal-mime stops above 2 MiB of headers; past that there is no parsed
  // message at all, and the worker must still store it rather than bounce it.
  const flood = Array.from({ length: 40_000 }, (_, i) => `X-Flood-${i}: ${'w'.repeat(60)}`);

  await handleEmail(message({ extraHeaders: flood }), { DB: db });

  const stored = storedEmail(db);
  assert.equal(stored.type, 'received');
  assert.equal(stored.subject, '(undecodable message)');
  assert.match(stored.body_text, /could not be parsed/);
});
