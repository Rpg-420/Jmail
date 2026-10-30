# Webhooks: letting JMail call your project

**فارسی:** [docs/fa/WEBHOOKS.md](fa/WEBHOOKS.md)

A webhook is how the mail server tells your project what happened to mail it
submitted — or that new mail arrived in a mailbox you use as an inbox. Your project
does not poll; it exposes one HTTPS endpoint and JMail POSTs signed JSON to it.

Register endpoints in the UI under **Mail server → Webhooks**, or with the admin API:

| Call | Purpose |
| --- | --- |
| `GET /api/hooks` | List endpoints (secret is masked) |
| `POST /api/hooks` | Create — body `{url, events?, token_id?}`; returns the secret **once** |
| `PUT /api/hooks/:id` | Update url / events / active |
| `POST /api/hooks/:id/rotate-secret` | New secret, old signatures stop verifying |
| `POST /api/hooks/:id/test` | Queue a synthetic event and deliver it immediately |
| `GET /api/hooks/:id/deliveries` | Last 50 attempts with status and error |
| `DELETE /api/hooks/:id` | Remove the endpoint |

`token_id` narrows an endpoint to events produced by one integration token —
usually what you want, so the billing app is not told about the blog's mail.

---

## 1. Request shape

```http
POST /your/webhook/handler HTTPS
User-Agent: JMail-Webhook/1.0
X-JMail-Event: sent
X-JMail-Delivery: 9f2c…               # unique per attempt target, stable across retries
X-JMail-Signature: t=1761686400,v1=5257a869e1…   # 64 hex chars
Content-Type: application/json
```

```json
{
  "id": "9f2c…",
  "type": "sent",
  "occurred_at": "2026-10-28T09:12:33.000Z",
  "data": {
    "id": "0f5c…",
    "to": "customer@example.com",
    "subject": "Invoice 42",
    "provider": "brevo",
    "provider_message_id": "<invoice-42@example.com>",
    "token_id": "tok_1"
  }
}
```

### Events

| Event | `data` contains | Fired when |
| --- | --- | --- |
| `sent` | id, to, subject, provider, provider_message_id, token_id | A relay accepted the message |
| `delivered` | id, to, recipient, subject, provider, provider_message_id, status, token_id | The relay reported delivery |
| `opened` | same as `delivered` | The relay reported an open or a click |
| `bounced` | same as `delivered` | The relay reported a hard bounce, block, or invalid address |
| `deferred` | same as `delivered` | The relay reported a soft bounce or deferral |
| `failed` | id, to, subject, error, attempts, token_id | Permanent rejection, or the retry ladder ran out |
| `received` | id, from, to, subject, preview, attachments, received_at | Inbound mail landed in a mailbox |

The four relay-reported events (`delivered`, `opened`, `bounced`, `deferred`) come
from the relay's own webhook. JMail registers it on the relay during the setup
wizard (`api/setup.ts` → `ensureBrevoWebhook`), pointing at
`POST /api/webhooks/brevo/<secret>` on this worker, where `<secret>` is the
`brevo_webhook_secret` row in the `settings` table. The API masks that value, so if
registration failed and you need to add the webhook in the relay's dashboard by
hand, read it straight from D1:

```bash
wrangler d1 execute jmail-db --remote \
  --command "SELECT value FROM settings WHERE key = 'brevo_webhook_secret'"
```

Then register `https://<your-worker-origin>/api/webhooks/brevo/<that-value>` for the
`request`, `delivered`, `hardBounce`, `softBounce`, `blocked`, `invalid_email`,
`deferred` and `uniqueOpened` events. Until you do, you still get `sent`, `failed`
and `received`, but nothing in between.
Out-of-order reports never downgrade a status: `queued → deferred → delivered →
opened` only moves forward.

`received` is what makes JMail usable as an *inbound* mail server for a project:
point an Email Routing rule at the worker, subscribe to `received`, and your app gets
new mail as a signed HTTP call.

---

## 2. Signature verification

The signature covers `<timestamp>.<raw body>`. Verify it with the endpoint secret
before parsing JSON, and reject timestamps older than a few minutes so a captured
request cannot be replayed.

**Read the raw bytes.** Any framework that re-serialises the parsed body changes
one character and breaks the HMAC.

### Node / Express

```js
import crypto from 'node:crypto';
import express from 'express';

const SECRET = process.env.JMAIL_WEBHOOK_SECRET;
const app = express();

app.post('/hooks/jmail', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.headers['x-jmail-signature'];
  if (!verify(header, req.body, SECRET)) return res.status(400).send('bad signature');

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.type === 'received') handleInboundMail(event.data);
  if (event.type === 'failed') markDeliveryFailed(event.data.id);

  res.status(200).send('ok');   // any 2xx counts as delivered
});

function verify(header, rawBody, secret) {
  const parts = Object.fromEntries(
    String(header ?? '').split(',').map(piece => {
      const at = piece.indexOf('=');
      return [piece.slice(0, at).trim(), piece.slice(at + 1).trim()];
    }).filter(([key]) => key)
  );
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;   // 5 min clock skew

  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
  if (parts.v1.length !== expected.length) return false;   // timingSafeEqual throws on unequal lengths
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

### Python / FastAPI

```python
import hashlib, hmac, time
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
SECRET = "whsec_…".encode()

@app.post("/hooks/jmail")
async def jmail_hook(request: Request, x_jmail_signature: str = Header(...)):
    body = await request.body()
    parts = dict(p.split("=", 1) for p in x_jmail_signature.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        raise HTTPException(400, "stale webhook")

    expected = hmac.new(SECRET, f'{parts["t"]}.{body.decode()}'.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts["v1"]):
        raise HTTPException(400, "bad signature")

    event = await request.json()
    if event["type"] == "received":
        handle_inbound_mail(event["data"])
    return {"ok": True}
```

### PHP / Laravel

Route (no CSRF middleware on this path — add it to `bootstrap/app.php` exclusions):

```php
Route::post('/hooks/jmail', JmailWebhookController::class)->middleware('api');
```

```php
public function __invoke(Request $request): JsonResponse
{
    $secret = config('services.jmail.webhook_secret');
    $raw    = $request->getContent();
    $header = $request->header('X-JMail-Signature', '');

    parse_str(str_replace(',', '&', $header), $parts);
    if (abs(time() - (int) ($parts['t'] ?? 0)) > 300) abort(400, 'stale webhook');

    $expected = hash_hmac('sha256', $parts['t'].'.'.$raw, $secret);
    if (!hash_equals($expected, $parts['v1'] ?? '')) abort(400, 'bad signature');

    $event = json_decode($raw, true);
    match ($event['type']) {
        'received' => $this->handleInboundMail($event['data']),
        'failed'   => $this->markDeliveryFailed($event['data']['id']),
        default    => null,
    };

    return response()->json(['ok' => true]);
}
```

---

## 3. Delivery guarantees

| Behaviour | Detail |
| --- | --- |
| Trigger | Cron, every 5 minutes by default |
| Retry ladder | 15 s, 1 min, 5 min, 30 min, 2 h, 6 h, 24 h, 48 h — 8 attempts, then `failed` |
| Success | Any 2xx; the row is closed |
| Permanent failure | Any 4xx except `408` and `429` — a broken handler is not retried |
| Retryable | `5xx`, timeouts (10 s), connection errors, `429` |
| Ordering | Not guaranteed. Two events for the same message can arrive in either order |
| Duplication | Rare (a delivery started just before its retry window). Dedupe on `X-JMail-Delivery` / `id` |

So: reply `200` fast, do the work asynchronously, and treat `id` as a dedupe key.

**Latency.** Events sit in the queue until the next cron tick — up to 5 minutes
after the send. If you want them sooner, set the cron to `*/2 * * * *` in
`wrangler.toml`. Delivery of `sent`/`failed` for an in-request `/send` is queued in
that same call, so it lands on the next tick like everything else.

---

## 4. Endpoint URL rules

- `https://` is strongly preferred; plain `http://` is accepted only for public hosts.
- Loopback, private, link-local, multicast and reserved addresses are refused
  (`127.0.0.1`, `10.*`, `172.16–31.*`, `192.168.*`, `169.254.*`, `::1`, `fc00::/7`,
  `fe80::/10`, …) as are `localhost`, `*.internal`, `*.local`, credentials in the
  URL, and non-HTTP schemes. This keeps a mail server on a shared network from
  becoming an internal port scanner.
- A hostname that *resolves* to a private address cannot be detected without doing
  the DNS lookup yourself; if that matters in your environment, run the endpoint
  behind a proxy that enforces it.

---

## 5. Testing a hook

1. **Mail server → Webhooks → Test** queues a synthetic event for the endpoint and
   delivers it inside the request, so the response tells you the HTTP status your
   handler returned and any error text.
2. Or hand-craft one with curl once the endpoint exists — the UI shows the masked
   secret; the full secret is only ever shown at creation, so rotate it if you lost it:

```bash
BODY='{"id":"manual-1","type":"sent","occurred_at":"2026-10-28T09:00:00Z","data":{"id":"mail_1","to":"you@example.com","subject":"test"}}'
TS=$(date +%s)
SIG="t=${TS},v1=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-JMail-Event: sent" \
  -H "X-JMail-Delivery: manual-1" \
  -H "X-JMail-Signature: $SIG" \
  --data "$BODY"
```

If your handler returns 200 here but nothing arrives from real sends, the endpoint
is not subscribed to that event, or `token_id` filtering excluded it.
