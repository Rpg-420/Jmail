import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../../../scripts/smtp-bridge.mjs', import.meta.url));
let nextPort = 2600 + (process.pid % 500);

/** @param {(payload: unknown) => {status: number, body: Record<string, unknown>}} respond */
function startApi(respond) {
  const payloads = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!req.url.endsWith('/api/v1/send')) { res.writeHead(404); res.end(); return; }
      const payload = JSON.parse(raw);
      payloads.push(payload);
      const { status, body } = respond(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '77' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, payloads })));
}

function startBridge(apiPort, extraEnv = {}) {
  const port = nextPort++;
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      JMAIL_API_URL: `http://127.0.0.1:${apiPort}`,
      JMAIL_TOKEN: 'test-token',
      JMAIL_SMTP_PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge did not start: ' + stderr.join(''))), 8000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve({ child, port, stderr });
    });
  });
}

/** Send each queue entry, waiting for a complete SMTP reply before the next. */
function talk(port, queue) {
  return new Promise((resolve) => {
    const replies = [];
    const lines = [...queue];
    let index = 0;
    let pending = '';
    const socket = net.connect(port, '127.0.0.1');
    const pump = () => {
      if (index < lines.length) socket.write(`${lines[index++]}\r\n`);
      else socket.end();
    };
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let cut;
      while ((cut = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        replies.push(line);
        if (/^\d{3} /.test(line)) pump();
      }
    });
    socket.on('error', () => resolve(replies));
    socket.setTimeout(8000, () => socket.destroy());
    socket.on('close', () => resolve(replies));
  });
}

const final = (replies) => replies.filter(line => /^\d{3} /.test(line));

async function run(queue, { respond = () => ({ status: 200, body: { id: 'm1', status: 'sent' } }), env } = {}) {
  const api = await startApi(respond);
  const bridge = await startBridge(api.port, env);
  try {
    const replies = await talk(bridge.port, queue);
    // The API call is awaited inside the bridge; give the promise chain a tick.
    await new Promise(resolve => setTimeout(resolve, 150));
    return { replies, payloads: api.payloads };
  } finally {
    bridge.child.kill();
    api.server.close();
  }
}

const envelope = ['EHLO test.local', 'MAIL FROM:<alerts@example.com>', 'RCPT TO:<boss@example.com>'];

const mimeMessage = [
  'From: Alerts <alerts@example.com>',
  'To: boss@example.com, ccfriend@example.com',
  'Cc: ccfriend@example.com',
  'Bcc: hidden@example.com',
  'Reply-To: nobody@example.com',
  'Subject: =?UTF-8?B?RGVwbG95IHJlcG9ydHM=?=',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('prod is up\n').toString('base64'),
  '--BOUND',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>prod =3D up</p>',
  '--BOUND--',
].join('\r\n');

test('flattens MIME into the /send payload and separates cc from the envelope', async () => {
  const { replies, payloads } = await run([
    ...envelope,
    'RCPT TO:<ccfriend@example.com>',
    'RCPT TO:<hidden@example.com>',
    'DATA',
    `${mimeMessage}\r\n.`,
    'QUIT',
  ]);

  assert.equal(final(replies).at(-2), '250 2.0.0 Accepted id=m1');
  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.equal(payload.from, 'alerts@example.com');
  assert.deepEqual(payload.to, ['boss@example.com'], 'only non-carbon envelope recipients go to "to"');
  assert.deepEqual(payload.cc, ['ccfriend@example.com']);
  assert.deepEqual(payload.bcc, ['hidden@example.com']);
  assert.equal(payload.subject, 'Deploy reports', 'RFC 2047 subject decoded');
  assert.equal(payload.text.trim(), 'prod is up');
  assert.equal(payload.html.trim(), '<p>prod = up</p>');
  assert.equal(payload.reply_to, 'nobody@example.com');
});

test('restores dot-stuffed lines inside DATA', async () => {
  const { payloads } = await run([
    ...envelope,
    'DATA',
    ['From: a@example.com', 'To: b@example.com', 'Subject: dots', '', 'one', '..two', 'three'].join('\r\n') + '\r\n.',
    'QUIT',
  ]);
  assert.equal(payloads[0].text, 'one\r\n.two\r\nthree');
});

test('a 429 from the API becomes a retryable 451 so the client keeps its queue', async () => {
  const { replies } = await run(
    [...envelope, 'DATA', 'Subject: q\r\nTo: b@example.com\r\nFrom: a@example.com\r\n\r\nhi\r\n.', 'QUIT'],
    { respond: () => ({ status: 429, body: { error: 'budget_exceeded', retry_after: 42 } }) }
  );
  assert.ok(final(replies).some(line => /^451 4\.7\.0 .*retry after 42s$/.test(line)), 'retryable with the API hint');
  assert.ok(!final(replies).some(line => line.startsWith('250 2.0.0')), 'not reported as accepted');
});

test('a 4xx rejection becomes a permanent 550, never a retry', async () => {
  const { replies } = await run(
    [...envelope, 'DATA', 'Subject: no\r\nTo: b@example.com\r\nFrom: a@example.com\r\n\r\nhi\r\n.', 'QUIT'],
    { respond: () => ({ status: 403, body: { error: 'unverified_sender' } }) }
  );
  assert.ok(final(replies).some(line => line.startsWith('550')), 'permanent failure class');
});

test('an unreachable API is a 451, not a lost message', async () => {
  const api = { port: 1, server: { close() {} }, payloads: [] };
  const bridge = await startBridge(api.port);
  try {
    const replies = await talk(bridge.port, [...envelope, 'DATA', 'Subject: x\r\nTo: b@example.com\r\nFrom: a@example.com\r\n\r\nhi\r\n.', 'QUIT']);
    assert.ok(final(replies).some(line => line.startsWith('451')));
  } finally {
    bridge.child.kill();
  }
});

test('accepts AUTH PLAIN and AUTH LOGIN when a bridge password is set', async () => {
  const password = 'sekret';
  const plain = await run(
    ['EHLO x', `AUTH PLAIN ${Buffer.from('\0user\0sekret').toString('base64')}`, ...envelope.slice(1), 'DATA', 'Subject: p\r\nTo: b@example.com\r\nFrom: a@example.com\r\n\r\nhi\r\n.', 'QUIT'],
    { env: { JMAIL_SMTP_PASSWORD: password } }
  );
  assert.ok(final(plain.replies).some(line => line.startsWith('235')));

  const login = await run(
    ['EHLO x', 'AUTH LOGIN', Buffer.from('user').toString('base64'), Buffer.from('sekret').toString('base64'), 'QUIT'],
    { env: { JMAIL_SMTP_PASSWORD: password } }
  );
  assert.ok(final(login.replies).some(line => line.startsWith('235')), 'challenge/response login');

  const wrong = await run(
    ['EHLO x', `AUTH PLAIN ${Buffer.from('\0user\0nope').toString('base64')}`, 'QUIT'],
    { env: { JMAIL_SMTP_PASSWORD: password } }
  );
  assert.ok(final(wrong.replies).some(line => line.startsWith('535')));
  assert.equal(wrong.payloads.length, 0);
});

test('refuses more recipients than the relays accept', async () => {
  const recipients = Array.from({ length: 51 }, (_, i) => `RCPT TO:<r${i}@example.com>`);
  const { replies } = await run(['EHLO x', 'MAIL FROM:<a@example.com>', ...recipients, 'QUIT']);
  assert.ok(final(replies).some(line => line.startsWith('550')), 'over-limit recipient rejected');
});

test('rejects an oversized message with 552 and stays usable', async () => {
  const big = 'x'.repeat(1024 * 1024);
  const { replies } = await run(
    [...envelope, 'DATA', `Subject: big\r\nTo: b@example.com\r\nFrom: a@example.com\r\n\r\n${big}\r\n.`, 'QUIT'],
    { env: { JMAIL_SMTP_MAX_BYTES: String(64 * 1024) } }
  );
  assert.ok(final(replies).some(line => line.startsWith('552')));
});

test('DATA without an envelope is refused and RSET clears state', async () => {
  const noRcpt = await run(['EHLO x', 'MAIL FROM:<a@example.com>', 'DATA', 'QUIT']);
  assert.ok(final(noRcpt.replies).some(line => line.startsWith('503')));

  const { payloads } = await run([
    'EHLO x',
    'MAIL FROM:<first@example.com>',
    'RCPT TO:<one@example.com>',
    'RSET',
    'MAIL FROM:<second@example.com>',
    'RCPT TO:<two@example.com>',
    'DATA',
    'Subject: after reset\r\nFrom: second@example.com\r\n\r\nhi\r\n.',
    'QUIT',
  ]);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].from, 'second@example.com');
  assert.deepEqual(payloads[0].to, ['two@example.com']);
});

test('honours JMAIL_FROM as the fixed sending identity', async () => {
  const { payloads } = await run(
    ['EHLO x', 'MAIL FROM:<>', 'RCPT TO:<b@example.com>', 'DATA', 'Subject: anon\r\n\r\nhi\r\n.', 'QUIT'],
    { env: { JMAIL_FROM: 'server@example.com' } }
  );
  assert.equal(payloads[0].from, 'server@example.com');
});
