#!/usr/bin/env node
/**
 * JMail SMTP bridge — speaks enough SMTP to be the "mail server" that
 * hard-coded SMTP clients expect (PHP's mail(), WordPress, Postfix nullclient,
 * Python's smtplib, a build server) and forwards every message to the JMail
 * HTTP mail API, so sending stays free and off your own box.
 *
 *   JMAIL_API_URL=https://jmail.example.workers.dev JMAIL_TOKEN=jm_... \
 *     node scripts/smtp-bridge.mjs
 *
 * Listens on 127.0.0.1:2525 by default. Point a local MTA at it as a relay host,
 * or set JMAIL_SMTP_PORT=25 to be the box's mail transport directly. Whatever can
 * reach this port can send as your token, so bind elsewhere only with
 * JMAIL_SMTP_PASSWORD set.
 *
 * Requires Node 18+. No dependencies.
 */
import { createServer } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const API_URL = (process.env.JMAIL_API_URL || 'http://localhost:8787').replace(/\/+$/, '');
const TOKEN = process.env.JMAIL_TOKEN || '';
const HOST = process.env.JMAIL_SMTP_HOST || '127.0.0.1';
const PORT = Number(process.env.JMAIL_SMTP_PORT || 2525);
const BRIDGE_PASSWORD = process.env.JMAIL_SMTP_PASSWORD || '';
const MAX_BYTES = Number(process.env.JMAIL_SMTP_MAX_BYTES || 4 * 1024 * 1024);
const IDENTITY = process.env.JMAIL_FROM || '';
const MAX_RECIPIENTS = 50;
const GREETING = 'JMail SMTP bridge';

const DATA_END = [Buffer.from('\r\n.\r\n'), Buffer.from('\n.\n')];

if (!TOKEN) {
  console.error('JMAIL_TOKEN is required — create one under Mail server -> Tokens.');
  process.exit(1);
}

/* ---------------------------------------------------------------- MIME utils */

/** Folded header block -> lowercased map, continuation lines unfolded. */
function parseHeaders(raw) {
  const headers = new Map();
  let key = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (key) headers.set(key, `${headers.get(key)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    key = line.slice(0, colon).trim().toLowerCase();
    headers.set(key, line.slice(colon + 1).trim());
  }
  return headers;
}

/** "=?utf-8?B?cmVwbGF5?=" and the Q variant, back to text. */
function decodeWords(value) {
  return String(value ?? '').replace(/=\?[^?]*\?([BbQq])\?([^?]*)\?=/g, (_, kind, data) => {
    if (kind.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
    const text = data
      .replace(/_/g, ' ')
      .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(text, 'binary').toString('utf8');
  });
}

function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBody(headers, body) {
  const encoding = (headers.get('content-transfer-encoding') || '').toLowerCase().trim();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/** Flatten MIME into { text, html }; multipart/alternative keeps both parts. */
function readMime(headers, body, out) {
  const contentType = headers.get('content-type') || 'text/plain';
  const boundary = contentType.match(/multipart\/[^;]*;\s*boundary="?([^";\r\n]+)"?/i);

  if (boundary) {
    const marker = `--${boundary[1]}`;
    for (const chunk of body.split(marker)) {
      const part = chunk.replace(/^-?\r?\n/, '');
      if (!part || part.startsWith('--')) continue;
      const separator = part.match(/\r?\n[ \t]*\r?\n/);
      if (!separator) continue;
      readMime(parseHeaders(part.slice(0, separator.index)), part.slice(separator.index + separator[0].length), out);
    }
    return out;
  }

  const decoded = decodeBody(headers, body);
  if (/text\/html/i.test(contentType)) out.html = out.html || decoded;
  else out.text = out.text || decoded;
  return out;
}

const emailOf = (entry) => String(entry).match(/<([^>]*)>/)?.[1]?.trim() || String(entry).trim();

function dedupe(list) {
  const seen = new Set();
  return list.filter((entry) => {
    const key = emailOf(entry).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Envelope + headers + MIME body -> the JSON shape /api/v1/send expects. */
function toApiPayload(envelope, message) {
  const gapMatch = message.match(/\r?\n\r?\n/);
  const gap = gapMatch ? gapMatch.index : -1;
  const headers = parseHeaders(gap < 0 ? message : message.slice(0, gap));
  const body = gap < 0 ? '' : message.slice(gap + gapMatch[0].length);

  const listFrom = (value) => dedupe(
    decodeWords(value)
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.includes('@'))
  );

  const cc = listFrom(headers.get('cc'));
  const bcc = listFrom(headers.get('bcc'));
  const carbon = new Set([...cc, ...bcc].map(entry => emailOf(entry).toLowerCase()));
  const rcpt = dedupe(envelope.rcpt);
  const to = rcpt.filter(entry => !carbon.has(emailOf(entry).toLowerCase()));

  const mime = readMime(headers, body, {});
  const subject = decodeWords(headers.get('subject')).trim() || '(no subject)';

  const payload = {
    from: IDENTITY || envelope.mail || emailOf(listFrom(headers.get('from'))[0] || '') || 'unknown@localhost',
    to: to.length ? to : rcpt,
    subject,
  };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (mime.html) payload.html = mime.html;
  if (mime.text) payload.text = mime.text;
  if (!payload.text && !payload.html) {
    payload.text = body.trim() || '(empty message)';
  }
  if (!payload.text && payload.html) {
    payload.text = payload.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const replyTo = headers.get('reply-to');
  if (replyTo) payload.reply_to = decodeWords(replyTo).trim();

  return payload;
}

/* -------------------------------------------------------------- API client */

/**
 * Translate an API answer into an SMTP reply: 250 accepted, 451 worth retrying
 * (quota, rate limit, upstream failure — the client's own queue will retry),
 * 550 never going to work (validation, scope, sender not allowed).
 */
async function postToApi(payload) {
  let response;
  try {
    response = await fetch(`${API_URL}/api/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return `451 4.3.0 JMail unreachable: ${error.message}`;
  }

  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* an HTML error page from a proxy */ }

  if (response.ok) return `250 2.0.0 Accepted id=${json.id ?? 'queued'}`;
  if (response.status === 429) {
    const wait = json.retry_after || response.headers.get('retry-after') || 60;
    return `451 4.7.0 JMail rate limit or daily quota; retry after ${wait}s`;
  }
  if (response.status >= 500) return `451 4.3.0 JMail returned ${response.status}`;
  return `550 5.7.1 Rejected by JMail: ${json.error || json.message || `HTTP ${response.status}`}`;
}

/* ------------------------------------------------------------ SMTP session */

const secureCompare = (provided, expected) => {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

function authenticate(session, token) {
  if (session.authStage === 'login-user') {
    session.authStage = 'login-pass';
    return `334 ${Buffer.from('Password:').toString('base64')}`;
  }
  const secret = session.authStage === 'login-pass'
    ? Buffer.from(token, 'base64').toString('utf8')
    : Buffer.from(token, 'base64').toString('utf8').split('\0').pop();
  session.authStage = null;
  return secureCompare(secret, BRIDGE_PASSWORD) ? '235 2.7.0 Authenticated' : '535 5.7.8 Authentication failed';
}

function handleLine(session, line) {
  const trimmed = line.trim();
  const [verb, ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(' ');
  const command = (verb || '').toUpperCase();

  // A base64 token is the whole line: no verb, no spaces.
  if (session.authStage) return authenticate(session, trimmed);

  switch (command) {
    case 'EHLO':
    case 'HELO': {
      if (!argument) return '501 5.5.4 Send a hostname';
      session.envelope = { mail: null, rcpt: [] };
      if (command === 'HELO') return `250 ${GREETING}`;
      const capabilities = ['SIZE', '8BITMIME', 'HELP'];
      if (BRIDGE_PASSWORD) capabilities.splice(1, 0, 'AUTH PLAIN LOGIN');
      return [`250-${GREETING}`,
        ...capabilities.map((item, index) => `${index === capabilities.length - 1 ? '250' : '250-'} ${item}`)
      ].join('\r\n');
    }

    case 'MAIL': {
      // <> is the RFC 5321 null reverse-path used for bounces — a valid sender.
      const match = argument.match(/<([^>]*)>/);
      if (!match) return '501 5.5.4 Expected MAIL FROM:<address>';
      session.envelope = { mail: match[1].trim(), rcpt: [] };
      return '250 2.1.0 Sender ok';
    }

    case 'RCPT': {
      const address = argument.match(/<([^>]*)>/)?.[1];
      if (!address) return '501 5.5.4 Expected RCPT TO:<address>';
      if (session.envelope.mail === null) return '503 5.5.1 Send MAIL FROM first';
      if (session.envelope.rcpt.length >= MAX_RECIPIENTS) {
        return `550 5.7.1 JMail relays at most ${MAX_RECIPIENTS} recipients per message`;
      }
      session.envelope.rcpt.push(address);
      return '250 2.1.5 Recipient ok';
    }

    case 'DATA':
      if (!session.envelope.rcpt.length) return '503 5.5.1 Send RCPT TO first';
      session.collecting = true;
      return '354 End data with <CR><LF>.<CR><LF>';

    case 'RSET':
      session.envelope = { mail: null, rcpt: [] };
      return '250 2.0.0 Reset';

    case 'NOOP':
      return '250 2.0.0';

    case 'HELP':
      return `214 2.0.0 ${GREETING} - forward-only bridge`;

    case 'AUTH':
      if (!BRIDGE_PASSWORD) return '503 5.5.2 This bridge needs no authentication';
      if (/^PLAIN\b/i.test(argument)) {
        const parts = argument.trim().split(/\s+/);
        if (parts.length > 1) {
          return secureCompare(Buffer.from(parts[1], 'base64').toString('utf8').split('\0').pop(), BRIDGE_PASSWORD)
            ? '235 2.7.0 Authenticated'
            : '535 5.7.8 Authentication failed';
        }
        session.authStage = 'plain';
        return '334 ';
      }
      if (/^LOGIN\b/i.test(argument)) {
        session.authStage = 'login-user';
        return `334 ${Buffer.from('Username:').toString('base64')}`;
      }
      return '504 5.5.2 Unsupported mechanism';

    case 'QUIT':
      session.closed = true;
      return '221 2.0.0 Bye';

    default:
      return `502 5.5.2 ${command || line.slice(0, 16)} not supported by this bridge`;
  }
}

/** RFC 5321 dot-unstuffing: a leading dot on a line was doubled in transit. */
const unstuff = (data) => data
  .replace(/\r\n\.(?=[^\r\n])/g, '\r\n')
  .replace(/^\.(?=[^\r\n])/, '');

function serve(socket) {
  socket.setNoDelay(true);

  const session = {
    envelope: { mail: null, rcpt: [] },
    authStage: null,
    collecting: false,
    closed: false,
    pending: Buffer.alloc(0),
    work: Promise.resolve(),
  };

  const say = (reply) => {
    if (reply && socket.writable) socket.write(`${reply}\r\n`);
  };

  socket.write(`220 ${GREETING}\r\n`);

  socket.on('data', (chunk) => {
    if (session.closed) return;
    session.pending = Buffer.concat([session.pending, chunk]);

    for (;;) {
      if (session.collecting) {
        if (session.pending.length > MAX_BYTES) {
          session.collecting = false;
          session.pending = Buffer.alloc(0);
          say('552 5.3.4 Message exceeds the bridge limit');
          return;
        }
        const ends = DATA_END.map(marker => session.pending.indexOf(marker));
        const index = ends[0] >= 0 ? ends[0] : ends[1];
        if (index < 0) return;
        const skip = ends[0] >= 0 ? DATA_END[0].length : DATA_END[1].length;
        const message = unstuff(session.pending.subarray(0, index).toString('utf8'));
        session.pending = session.pending.subarray(index + skip);
        session.collecting = false;

        const envelope = session.envelope;
        // One message in flight per connection keeps the SMTP reply ordering sane.
        session.work = session.work.then(async () => {
          say(await postToApi(toApiPayload(envelope, message)));
        });
        continue;
      }

      const newline = session.pending.indexOf(0x0a);
      if (newline < 0) {
        if (session.pending.length > 512) {
          session.closed = true;
          say('500 5.5.2 Command line too long');
        }
        return;
      }
      const raw = session.pending.subarray(0, newline);
      session.pending = session.pending.subarray(newline + 1);
      if (raw.length > 512) {
        session.closed = true;
        say('500 5.5.2 Command line too long');
        return;
      }
      say(handleLine(session, raw.toString('utf8').replace(/\r$/, '')));
      if (session.closed) { socket.end(); return; }
      if (session.collecting) return;
    }
  });

  const close = () => {
    if (!session.closed) {
      session.closed = true;
      socket.destroy();
    }
  };

  socket.on('end', () => { if (!session.closed) socket.end(); });
  socket.on('error', close);
  socket.on('timeout', close);
}

const server = createServer(serve);

server.listen(PORT, HOST, () => {
  console.log(`JMail SMTP bridge on ${HOST}:${PORT} -> ${API_URL}/api/v1/send`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !BRIDGE_PASSWORD) {
    console.warn('WARNING: bound to a non-loopback address without JMAIL_SMTP_PASSWORD — anyone who can reach this port sends as your token.');
  }
});

server.on('error', (error) => {
  console.error(`bridge failed: ${error.message}`);
  process.exit(1);
});
