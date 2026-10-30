# Connect your projects to JMail

**فارسی:** [docs/fa/INTEGRATIONS.md](fa/INTEGRATIONS.md)

JMail is the mail server your other projects talk to. Instead of installing
postfix/exim/SMTP credentials on each box, each project makes one HTTPS call to
the Worker with its own token, and inbound mail arrives as a webhook or a poll.

Everything here is the free tier. Endpoint details live in
[`API.md`](./API.md), webhook signatures in [`WEBHOOKS.md`](./WEBHOOKS.md).

**Pick your path**

| Your project… | Use | Go to |
| --- | --- | --- |
| can make an HTTP request | `POST /api/v1/send` | §2–§4 |
| can only speak SMTP (WordPress, Laravel, PHP `mail()`, a build server) | the SMTP bridge | §6 |
| needs to read mail it receives (support inbox, verification replies) | `GET /api/v1/messages` or the `received` webhook | §5 |
| must know whether mail actually landed | `status` scope + webhooks | §7 |
| runs in CI and should not spam your quota | token with a small daily budget | §8 |

---

## 1. One token per project

**Mail server → Project tokens → New token** in the web app, or:

```bash
curl -sS -X POST "$JMAIL_URL/api/tokens" \
  -H "Authorization: Bearer $JMAIL_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"billing-app","scopes":["send","status"],"identity_address":"billing@yourdomain","rate_per_min":10,"daily_budget":200}'
```

The response contains `"secret"` exactly once (`jmail_…`); it is stored as a
SHA-256 hash, so a lost secret means a new token, not a recovery.

| Field | What it protects |
| --- | --- |
| `scopes` | `send` posts mail, `read` reads inbound, `status` queries your own sends and quota |
| `identity_address` | pins the `from` — the token cannot impersonate another address |
| `rate_per_min` | per-token limiter (1–120, default 60), so a runaway loop stays inside one project |
| `daily_budget` | per-token sends per UTC day (1–5000, default 200), separate from the relay quota |

The reply is `201` with `{ token, secret, warning }`; only `secret` is shown once.

Put the secret in the project's environment (`JMAIL_TOKEN`), never in a repo, a
mobile app, or browser code — see §9.

Sanity check before you wire anything up:

```bash
curl -sS "$JMAIL_URL/api/v1/whoami" -H "Authorization: Bearer $JMAIL_TOKEN"
```

---

## 2. curl

```bash
export JMAIL_URL=https://jmail.your-account.workers.dev
export JMAIL_TOKEN=jmail_xxx

curl -sS -X POST "$JMAIL_URL/api/v1/send" \
  -H "Authorization: Bearer $JMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "alerts@yourdomain",
    "to": ["you@yourdomain"],
    "subject": "Deploy finished",
    "text": "prod is up.",
    "idempotency_key": "deploy-2026-10-28"
  }'
```

`"to"` takes an array (a one-element array is fine — a bare string works too, but
keep it an array in code you generate), and `"from"` must be
either the token's pinned identity or an address from **Settings → Addresses**.

---

## 3. Node.js — a whole client, no dependencies

Drop this file in the project and set `JMAIL_URL` + `JMAIL_TOKEN`.

```js
// jmail.mjs
const BASE = process.env.JMAIL_URL;
const TOKEN = process.env.JMAIL_TOKEN;

async function request(path, options = {}, attempt = 0) {
  const response = await fetch(`${BASE}/api/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {}),
    },
  });

  // 451-ish story: the API says when to come back, so honour it instead of
  // hammering a saturated free quota.
  if (response.status === 429 && attempt < 3) {
    const body = await response.json().catch(() => ({}));
    const wait = Number(body.retry_after || response.headers.get('retry-after') || 30);
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    return request(path, options, attempt + 1);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `http_${response.status}`);
    error.status = response.status;
    error.detail = body;
    throw error;
  }
  return body;
}

export const sendMail = (message) => request('send', {
  method: 'POST',
  body: JSON.stringify({
    from: message.from,
    to: [message.to].flat(),
    cc: message.cc ? [message.cc].flat() : undefined,
    bcc: message.bcc ? [message.bcc].flat() : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    reply_to: message.replyTo,
    send_at: message.sendAt,
    labels: message.labels,
    idempotency_key: message.idempotencyKey,
    attachments: message.attachments?.map(file => ({
      filename: file.filename,
      content: file.content.toString('base64'),
      content_type: file.contentType,
    })),
  }),
});

export const mailStatus = (id) => request(`messages/${id}`);
export const inbox = (query = '') => request(`messages?direction=inbound${query}`);
export const quota = () => request('quota');
```

Use it:

```js
import { readFileSync } from 'node:fs';
import { sendMail } from './jmail.mjs';

const result = await sendMail({
  from: 'receipts@yourdomain',
  to: 'customer@example.org',
  subject: 'Your invoice',
  text: 'Thanks! Invoice #1042 is attached.',
  html: '<p>Thanks! Invoice <b>#1042</b> is attached.</p>',
  idempotencyKey: 'invoice-1042',          // retrying this send cannot double-bill
  attachments: [{
    filename: 'invoice-1042.pdf',
    content: readFileSync('./invoice-1042.pdf'),
    contentType: 'application/pdf',
  }],
});

console.log(result.id, result.status);       // status: sent | queued | deferred | failed
```

---

## 4. Python

```python
import os, time, requests

BASE = os.environ["JMAIL_URL"].rstrip("/")
TOKEN = os.environ["JMAIL_TOKEN"]

def send(**message):
    for attempt in range(4):
        response = requests.post(
            f"{BASE}/api/v1/send",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json={"from": "alerts@yourdomain", **message},
            timeout=15,
        )
        if response.status_code == 429:
            time.sleep(int(response.json().get("retry_after", 30)))
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError("JMail is rate limiting us")

mail = send(to=["you@yourdomain"], subject="Job done", text="The nightly import finished.")
print(mail["id"], mail["status"])
```

…or the Django idiom, replacing `EMAIL_FILE_BACKEND` entirely:

```python
# views.py
from django.conf import settings
import requests

def notify(order):
    requests.post(
        f"{settings.JMAIL_URL}/api/v1/send",
        headers={"Authorization": f"Bearer {settings.JMAIL_TOKEN}"},
        json={
            "from": "shop@yourdomain",
            "to": [order.email],
            "subject": f"Order {order.id} shipped",
            "html": render_to_string("order_shipped.html", {"order": order}),
            "text": f"Order {order.id} shipped.",
            "idempotency_key": f"order-{order.id}-shipped",
        },
        timeout=15,
    ).raise_for_status()
```

No stdlib-only variant needed — but if you cannot install `requests`,
`urllib.request` works the same way:

```python
import json, os, urllib.request

def send(payload):
    request = urllib.request.Request(
        f"{os.environ['JMAIL_URL']}/api/v1/send",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {os.environ['JMAIL_TOKEN']}",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)
```

---

## 5. PHP

Plain function:

```php
<?php
function jmail_send(array $message): array {
    $url = rtrim(getenv('JMAIL_URL'), '/') . '/api/v1/send';
    $handle = curl_init($url);
    curl_setopt_array($handle, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($message),
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . getenv('JMAIL_TOKEN'),
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($handle);
    if (curl_errno($handle)) throw new RuntimeException('JMail: ' . curl_error($handle));
    $status = curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);

    $payload = json_decode($body, true) ?? [];
    if ($status >= 400) throw new RuntimeException($payload['error'] ?? "JMail HTTP $status");
    return $payload;
}

jmail_send([
    'from' => 'form@yourdomain',
    'to' => ['you@yourdomain'],
    'subject' => 'Contact form',
    'text' => "Name: {$_POST['name']}\n{$_POST['message']}",
    'reply_to' => $_POST['email'],
]);
```

**Laravel.** Easiest path for Laravel is SMTP — point it at the bridge (§6) and
leave your `Mail::` calls untouched. If you'd rather call the API directly, write
a transport:

```php
// app/Mail/JMailTransport.php
namespace App\Mail;

use Illuminate\Mail\Transport\Transport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\Email;

class JMailTransport extends Transport
{
    public function send(Email $email, array $sent = []): void
    {
        $list = fn ($addresses) => array_map(fn (Address $a) => $a->getAddress(), $addresses);

        $this->post([
            'from' => $email->getFrom()[0]?->getAddress(),
            'to' => array_merge($list($email->getTo()), $list($email->getCc())),
            'subject' => $email->getSubject(),
            'text' => $email->getTextBody(),
            'html' => $email->getHtmlBody(),
        ]);
    }

    private function post(array $payload): void
    {
        \Http::withToken(config('services.jmail.token'))
            ->post(rtrim(config('services.jmail.url'), '/') . '/api/v1/send', $payload)
            ->throw();
    }
}
```

Register it in `AppServiceProvider::boot()`:

```php
Illuminate\Support\Facades\Mail::extend('jmail', fn () => new App\Mail\JMailTransport());
```

and set `MAIL_MAILER=jmail` plus `JMAIL_URL` / `JMAIL_TOKEN` in `config/services.php`.

---

## 6. Projects that only speak SMTP: the bridge

Some things cannot be made to call an HTTP API — WordPress with the default mailer,
PHP's `mail()`, a Postfix that thinks it *is* the mail server, an old reporting tool.
`scripts/smtp-bridge.mjs` is a tiny SMTP server that accepts their mail and forwards
it to `/api/v1/send`, so JMail stays the single mail server behind all of them.

```bash
JMAIL_API_URL=https://jmail.your-account.workers.dev \
JMAIL_TOKEN=jmail_xxx \
node scripts/smtp-bridge.mjs
# JMail SMTP bridge on 127.0.0.1:2525 -> https://…/api/v1/send
```

It understands the parts of SMTP that matter in practice: `EHLO`/`HELO`,
`MAIL FROM` (including the null reverse-path `<>`), `RCPT TO`, `DATA` with
dot-unstuffing, `RSET`, `AUTH PLAIN`/`AUTH LOGIN`, `NOOP`, `QUIT`. On the MIME side
it decodes base64 and quoted-printable bodies, unfolds and RFC 2047-decodes headers,
splits `multipart/alternative` into the API's `text` and `html`, and moves `Cc`/`Bcc`
into their own fields.

**Environment**

| Variable | Default | Meaning |
| --- | --- | --- |
| `JMAIL_API_URL` | `http://localhost:8787` | Worker base URL (note: `JMAIL_API_URL`, not `JMAIL_URL`) |
| `JMAIL_TOKEN` | — required | project's API token |
| `JMAIL_SMTP_HOST` | `127.0.0.1` | bind address |
| `JMAIL_SMTP_PORT` | `2525` | bind port; `25` if you make it the box's transport |
| `JMAIL_SMTP_PASSWORD` | empty | when set, the bridge advertises and requires AUTH |
| `JMAIL_SMTP_MAX_BYTES` | 4 MiB | rejects a larger message with `552` |
| `JMAIL_FROM` | empty | force one sending identity for every message |

**Failure semantics are SMTP-correct**, which is what makes it safe to front a real
queue: the API's `429` (rate limit or daily quota) and `5xx` become `451` temporary
failures, so the client MTA retries later; a `400/403/422` becomes `550`, a permanent
bounce, so nothing retries forever. JMail's own queue still holds anything it
accepted.

### Wiring it up

**WordPress** — Settings → *WP Mail SMTP* (or an mu-plugin), or without a plugin:

```php
// wp-content/mu-plugins/jmail.php
add_action('phpmailer_init', function ($mailer) {
    $mailer->isSMTP();
    $mailer->Host = '127.0.0.1';
    $mailer->Port = 2525;
    $mailer->SMTPAuth = false;
    $mailer->From = 'site@yourdomain';
    $mailer->FromName = 'My Site';
});
```

**Laravel / Symfony** — `config/mail.php` stays the `smtp` mailer:

```env
MAIL_MAILER=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_USERNAME=anything
SMTP_PASSWORD=sekret   # only if JMAIL_SMTP_PASSWORD is set
MAIL_FROM_ADDRESS=app@yourdomain
```

**Python's smtplib**

```python
import smtplib
from email.message import EmailMessage

mail = EmailMessage()
mail["From"] = "reports@yourdomain"
mail["To"] = "you@yourdomain"
mail["Subject"] = "Weekly report"
mail.set_content("See the attached CSV.")
mail.add_attachment(open("report.csv", "rb").read(), maintype="text", subtype="csv", filename="report.csv")

with smtplib.SMTP("127.0.0.1", 2525) as server:
    server.send_message(mail)
```

**PHP `mail()`** — give PHP an SMTP-speaking sendmail. If `msmtp` is installed:

```ini
; /etc/php/8.3/fpm/php.ini
sendmail_path = /usr/bin/msmtp -t --host=127.0.0.1 --port=2525 -f site@yourdomain
```

…or put the bridge on port 25 (or 587) and set Postfix `relayhost = [127.0.0.1]:2525`
so the whole server's mail funnels through JMail.

**systemd unit** (`/etc/systemd/system/jmail-bridge.service`):

```ini
[Unit]
Description=JMail SMTP bridge
After=network-online.target

[Service]
EnvironmentFile=/etc/jmail-bridge.env
ExecStart=/usr/bin/node /opt/jmail/scripts/smtp-bridge.mjs
Restart=always
RestartSec=5
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now jmail-bridge
```

**Keep it on localhost.** Anything that can reach this port can send as your token.
If you must bind elsewhere, set `JMAIL_SMTP_PASSWORD` — and prefer an SSH tunnel or
a WireGuard interface over a public bind.

---

## 7. Delivery status: webhook first, polling second

Subscribe to [`WEBHOOKS.md`](./WEBHOOKS.md) events (`sent`, `delivered`, `opened`,
`bounced`) and store `provider_message_id` against your own record. That is the push
path, and it is what makes status free — no cron hammering the API.

If a project only has `status` scope, or you want a reconciler:

```bash
# one message
curl -sS "$JMAIL_URL/api/v1/messages/<id>" -H "Authorization: Bearer $JMAIL_TOKEN"

# anything that never left the queue
curl -sS "$JMAIL_URL/api/v1/messages?status=deferred&limit=50" -H "Authorization: Bearer $JMAIL_TOKEN"

# did this specific business event get through?
curl -sS "$JMAIL_URL/api/v1/messages?idempotency_key=invoice-1042" -H "Authorization: Bearer $JMAIL_TOKEN"
```

A token only sees its own messages, so a compromised project cannot read another
project's mail.

**Statuses you will see**

`pending` → `queued` → `delivered` → `opened`, with `deferred` (retrying, nothing lost),
`bounced` (address is dead) and `failed` (gave up: permanent relay rejection, or the
retry ladder — and then `queue_retention_days` — ran out).

---

## 8. Reading inbound mail (support inbox, reply-based verification)

Give a token the `read` scope and poll:

```bash
curl -sS "$JMAIL_URL/api/v1/messages?direction=inbound&unread=true&limit=20" \
  -H "Authorization: Bearer $JMAIL_TOKEN"
```

```python
import requests

def ticket_from(message):
    body = requests.get(
        f"{BASE}/api/v1/messages/{message['id']}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=15,
    ).json()
    return body  # includes `text`/`html`, `headers`, `attachments`, `thread_id`

def poll_unread():
    listing = requests.get(
        f"{BASE}/api/v1/messages",
        params={"direction": "inbound", "unread": "true", "limit": 25},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=15,
    ).json()["messages"]

    for item in listing:
        ticket = ticket_from(item)
        create_ticket(ticket)
        # threading: reply with the original `message_id` as In-Reply-To
        send(to=[ticket["from"]], subject=f"Re: {ticket['subject']}", text="We're on it.")
        requests.post(f"{BASE}/api/v1/messages/{item['id']}/read",
                      headers={"Authorization": f"Bearer {TOKEN}"}, timeout=15)
```

Attachment bytes:

```bash
curl -sS -o invoice.pdf "$JMAIL_URL/api/v1/messages/<id>/attachments/<attachmentId>" \
  -H "Authorization: Bearer $JMAIL_TOKEN"
```

Prefer the `received` webhook for anything latency-sensitive; polling is fine for a
cron every few minutes and keeps the integration stateless. Remember the platform
cap: Email Routing only hands over messages up to ~5 MiB.

---

## 9. Rules that keep this boring

- **Never call the API from a browser or mobile app.** The token would be public, and
  the API rejects cross-origin mutations anyway. Your backend calls JMail; the client
  calls your backend.
- **Do not take `from` from user input.** Pin `identity_address` per token and let
  JMail fill it in. Use `reply_to` for the user's address.
- **One token per project.** `rate_per_min` and `daily_budget` are what stop a bug in
  project A from eating your whole day of free quota.
- **Idempotency keys are business identifiers** — `invoice-1042`, `order-9021-shipped` —
  not random UUIDs. That's what makes a retry safe.
- **Treat `429` as "sleep and retry"**, `422` as "the message is wrong, fix the code".
- **Watch `GET /api/v1/quota`** before a big run: `total_remaining_today` is the sum of
  what the configured relays still allow.
- Free relays reset at **00:00 UTC**. Mail sent into an exhausted day is *deferred*, not
  dropped, and goes out on the next tick — but if your app needs instant delivery at
  23:55, that is the hour to know about.

---

## 10. Copy-paste recipes

**GitHub Actions — notify on deploy failure**

```yaml
- name: Mail me
  if: failure()
  env:
    JMAIL_URL: ${{ vars.JMAIL_URL }}
    JMAIL_TOKEN: ${{ secrets.JMAIL_TOKEN }}
  run: |
    curl -fsS -X POST "$JMAIL_URL/api/v1/send" \
      -H "Authorization: Bearer $JMAIL_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"from\":\"ci@yourdomain\",\"to\":[\"you@yourdomain\"],\"subject\":\"${GITHUB_REPOSITORY} failed\",\"text\":\"Run ${GITHUB_RUN_ID}\",\"idempotency_key\":\"${GITHUB_RUN_ID}\"}"
```

**cron / anacron — nightly backup report**

```sh
#!/bin/sh
set -eu
STATUS=$(pg_backup || echo failed)
curl -fsS -X POST "$JMAIL_URL/api/v1/send" \
  -H "Authorization: Bearer $JMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"backup@yourdomain\",\"to\":[\"you@yourdomain\"],\"subject\":\"Backup $STATUS\",\"text\":\"$(date -Is)\",\"idempotency_key\":\"backup-$(date +%F)\"}"
```

The key is `backup-YYYY-MM-DD`, so a re-run of the same day's job cannot send twice.

**Scheduled send — a reminder two days out**

```bash
curl -sS -X POST "$JMAIL_URL/api/v1/send" \
  -H "Authorization: Bearer $JMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"you@yourdomain","to":["you@yourdomain"],"subject":"Renew the domain","text":"due 2026-11-01","send_at":"2026-10-31T09:00:00Z"}'
```

`send_at` in the future returns `202 queued_for:<when>` and the cron delivers it; the
row survives a relay outage and retries on the ladder.

**Forward a form submission to three people, one call**

```json
{
  "from": "form@yourdomain",
  "to": ["sales@yourdomain", "founder@yourdomain"],
  "cc": ["crm@example-tool.com"],
  "subject": "New lead",
  "html": "<p><b>Jane</b> asked about the annual plan.</p>",
  "text": "Jane asked about the annual plan.",
  "reply_to": "jane@example.org"
}
```
