# JMail API reference

**فارسی:** [docs/fa/API.md](fa/API.md)

JMail is a private mail server that runs on Cloudflare's free tier. Other projects
talk to it over plain HTTPS with a bearer token — there is no SMTP port, no SMTP
library, and no outbound connection for you to manage.

- Base URL: `https://<your-worker-or-domain>/api/v1`
- Content type: `application/json` (UTF-8) everywhere
- Auth: `Authorization: Bearer jmail_<secret>`
- Health probe (no auth): `GET /api/health`

Everything below is enforced by the worker itself, not by convention.

---

## 1. Getting a token

Create tokens in the web UI under **Mail server → Project tokens** (`/mail-server`), or with
your session cookie:

```bash
curl -X POST https://mail.example.com/api/tokens \
  -H "Authorization: Bearer <your web session token>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"billing-app","scopes":["send","status"],"identity_address":"billing@example.com","rate_per_min":30,"daily_budget":200}'
```

(The session token is the one the web UI holds in `localStorage.jmail_token` after
you sign in; it authenticates the admin endpoints. Integration tokens are a separate
namespace and only work on `/api/v1`.)

The response contains `secret` **once** — it is stored as a SHA-256 hash, so it can
never be shown again. If it is lost, revoke the token and mint a new one.

| Field | Range | Meaning |
| --- | --- | --- |
| `name` | ≤ 60 chars | Shown in the UI; also applied as a label on every message the token sends |
| `scopes` | `send`, `read`, `status` | Defaults to `["send","status"]` |
| `identity_address` | address or `null` | Pins the sender: the token may only ever mail as this address |
| `rate_per_min` | 1–120 (default 60) | Sliding window per token |
| `daily_budget` | 1–5000 (default 200) | Sends per UTC day; resets at midnight UTC |

**Scopes**

| Scope | Grants |
| --- | --- |
| `send` | `POST /send` |
| `read` | Inbound mail: bodies, attachments, `.eml` download, marking read |
| `status` | `GET /quota` |

Every endpoint under `/api/v1` requires a token. There is no anonymous access, and
failed token guesses are rate limited per IP (100 attempts / 15 min).

---

## 2. Sending: `POST /api/v1/send`

```json
{
  "to": ["customer@example.com", {"email": "alice@client.dev", "name": "Alice"}],
  "cc": "bob@client.dev",
  "subject": "Invoice 42",
  "text": "Plain text body",
  "html": "<p>HTML body</p>",
  "from": "billing@example.com",
  "reply_to": "replies@example.com",
  "headers": { "X-Invoice-Id": "42" },
  "attachments": [{ "filename": "invoice.pdf", "content": "JVBERi0xLjQK…", "content_type": "application/pdf" }],
  "labels": ["invoices"],
  "idempotency_key": "invoice-42-first-send",
  "send_at": "2026-11-02T09:00:00Z"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `to` | yes | String or array of strings or `{email, name}`. Max **50** recipients across to+cc+bcc |
| `subject` | yes | Max **998** characters |
| `text` / `html` | at least one | `text` ≤ 1 MB, `html` ≤ 2 MB. Sent as-is — sanitise your own HTML |
| `from` | no | Required unless the token is pinned to an identity address — there is no fallback address, so omitting it returns `400`. Must be a configured From address unless the token is pinned |
| `cc`, `bcc` | no | Same shapes as `to` |
| `reply_to` | no | Also accepted as `replyTo` |
| `headers` | no | Max 20 entries. See §5 |
| `attachments` | no | Base64. Max 10 files, 5 MB each, 10 MB total (admin-tunable) |
| `labels` | no | Up to 20 labels of ≤ 40 chars; the token name is always added |
| `idempotency_key` | no | ≤ 120 chars, scoped to your token. See §4 |
| `send_at` | no | Future ISO-8601. Past timestamps are rejected |

### Responses

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | message + `provider`, `provider_message_id` | A relay accepted the message |
| `200` | message + `deduplicated: true` | The idempotency key was already used; nothing was sent twice |
| `202` | message + `status: "queued"`, `retrying: true`, `reason` | Stored and retried automatically — no relay capacity right now, or a relay is down |
| `202` | message + `status: "queued"` | The queue's cron claimed the row while this request was in flight; it will be delivered by that drain |
| `202` | message + `queued_for` | Scheduled send; the queue drains it at `send_at` |
| `400` | `invalid_request` | Validation failed; fixing the payload is the only way through |
| `401` | `unauthorized` | Missing, unknown, or revoked token |
| `403` | `forbidden`, `identity_mismatch`, `unverified_sender` | Scope, pinned-identity, or unknown sender |
| `422` | `rejected_by_relay` | The relay refused the message itself. Retrying will not help |
| `429` | `rate_limited` or `budget_exceeded` | Slow down; `retry_after` tells you when |

`GET /api/health` returns `next_utc_midnight` in seconds — use it to reset your own
counters at the same moment the server does.

### What a `202` means for your data

Nothing is lost. A `202` row stays in the send queue with a backoff ladder
(30 s → 2 min → 5 min → … → 24 h, 10 attempts) and the cron delivers it once a
relay has capacity. Rows still undelivered after the retention window
(`queue_retention_days`, default 14) are marked `failed` and a `failed` webhook fires.

One drain owns a row at a time: whoever claims it holds a 10-minute lease, so an
overlapping cron tick or a request that races the cron cannot post the same
message twice. If a Worker is killed after a relay accepted the message but
before the result was stored, the lease lapses and the send is retried — delivery
is at-least-once in that rare case, so keep sending an `Idempotency-Key` and
dedupe on your side by the message id.

---

## 3. Reading mail: `GET /api/v1/messages`

Outbound mail **sent by your own token** is always visible to it. Inbound mail
requires the `read` scope.

```bash
curl -H "Authorization: Bearer $JMAIL_TOKEN" \
  'https://mail.example.com/api/v1/messages?limit=20&status=delivered'

curl -H "Authorization: Bearer $JMAIL_TOKEN" \
  'https://mail.example.com/api/v1/messages?direction=inbound&unread=true&label=support'
```

Query parameters: `limit` (1–100, default 25), `offset`, `status`,
`idempotency_key`, `direction=inbound`, `unread=true`, `label`.

Message view (list and single):

```json
{
  "id": "0f5c…", "direction": "outbound", "from": "billing@example.com",
  "to": "customer@example.com", "cc": null, "subject": "Invoice 42",
  "status": "delivered", "provider": "brevo", "attempts": 1, "last_error": null,
  "labels": ["billing-app"], "message_id": "<…>", "thread_id": "<…>",
  "created_at": "2026-10-28 09:12:33", "scheduled_at": "2026-10-28 09:12:33"
}
```

Bodies never appear in a list. Fetch one message to get them:

| Endpoint | Scope | Returns |
| --- | --- | --- |
| `GET /messages/:id` | owner, or `read` for inbound | Message view; the `read` scope on inbound mail adds `text`, `html`, safe `headers` and attachment metadata |
| `GET /messages/:id/attachments/:attachmentId` | `read` | Raw bytes with `Content-Disposition` |
| `GET /messages/:id/eml` | `read` | `message/rfc822` download |
| `POST /messages/:id/read` | `read` | `{success: true}` |

A message id that belongs to a different token answers `404`, not `403` — the API
does not confirm that someone else's mail exists.

---

## 4. Idempotency

`idempotency_key` de-duplicates retries over a flaky network. The lookup is scoped
to your token, so two projects may reuse the same key without colliding.

- First call with a key: normal send.
- Any later call with the same key: `200` with the original message and `deduplicated: true`. No relay call, no quota burn.
- Keys are retained with the message, not in a short-lived cache — a retry an hour later is still safe.

Use a business identifier (`invoice-42-password-reset-2026-10-28`), not a random UUID,
or the guarantee is worthless.

---

## 5. Custom headers

Only these may be set by a caller:

- any name starting with `x-`
- `Reply-To`, `In-Reply-To`, `References`

Everything else is refused with `400`, including `From`, `To`, `Cc`, `Bcc`,
`Subject`, `Content-Type`, `MIME-Version`, `Message-ID`, `Date`, `Sender`,
`Return-Path`, `Received`, and `DKIM-Signature`. Header values containing CR or LF
are rejected outright, so a payload can never inject extra headers or recipients.

`Reply-To` is copied into the relay request, so threading and bounce routing behave
as your project expects.

---

## 6. Quota: `GET /api/v1/quota`

Requires the `status` scope.

```json
{
  "day": "2026-10-28",
  "token": { "name": "billing-app", "daily_budget": 200, "sent_today": 12, "failed_today": 1, "remaining_today": 187, "rate_per_min": 30 },
  "providers": [{ "id": "brevo", "label": "Brevo", "quota_day": 300, "used_day": 88, "remaining_day": 212 }],
  "total_remaining_today": 212
}
```

Three independent budgets always apply, and the tightest one wins:

1. **Your token's daily budget** — per project, so one runaway app cannot exhaust the whole mailbox.
2. **Each relay's free daily quota** — Brevo 300/day, Resend 100/day on their free plans. JMail tracks usage locally and stops offering a message to a relay whose daily quota is spent. A monthly ceiling (Resend also caps 3 000/month) is enforced only if you set it: write the setting `provider_quota_resend_month` to `3000` and that number joins the check too.
3. **Worker request limits** — Cloudflare free tier: 100 000 requests/day, 10 ms CPU per request (network wait excluded).

When every relay is spent, sends do not fail: they return `202` and stay queued, and
the queue drains as soon as a relay's quota refills at UTC midnight. Poll
`/quota` if your project wants to back off before that happens.

---

## 7. Webhooks

JMail pushes delivery events to your project so it does not have to poll.
Register endpoints under **Mail server → Webhooks**; the payload, signature scheme,
per-language verification code, and retry ladder are documented in
[WEBHOOKS.md](WEBHOOKS.md).

Events: `sent`, `delivered`, `opened`, `bounced`, `deferred`, `failed`, `received`.

---

## 8. Token identity and sender pinning

Unpinned tokens may only use From addresses that exist in **Settings → Addresses**.
A token with `identity_address` set can never mail as anybody else — omit `from`
entirely and the pinned address is used, or send it explicitly and the API checks it
matches (case-insensitive).

For a project that only ever sends as one address, pinning is the safer choice: a
compromised token cannot spoof your other identities.

---

## 9. Calling from a browser

Do it from your backend instead. Cross-origin `POST` is refused by design
(`routes.ts` rejects any non-GET request whose `Origin` is not the mail server's own
host), and a bearer token in browser code is a token you have published.
The one exception is local development against `localhost:5173`.

---

## 10. Limits cheat sheet

| Thing | Limit | Why |
| --- | --- | --- |
| Recipients per message | 50 | Every supported relay caps free sends at 50 |
| Subject | 998 chars | Cloudflare Email Routing outbound header cap |
| Text / HTML body | 1 MB / 2 MB | Worker memory budget per request |
| Attachment (file / total / count) | 5 MB / 10 MB / 10 | 10 MB base64 ≈ 13 MB JSON, inside the Worker request cap |
| Idempotency key | 120 chars | Indexed column |
| Custom headers | 20 entries, 500 chars each | Header budget shared with the relay |
| Queue retention | 14 days (configurable) | Undeliverable mail should not sit forever |

---

## 11. Error shapes

Every error is JSON with a machine-readable `error` and a human `message`:

```json
{ "error": "rate_limited", "message": "Token limit is 30 requests per minute", "retry_after": 41 }
```

| `error` | Status | Retry? |
| --- | --- | --- |
| `invalid_request` | 400 | No — fix the payload |
| `unauthorized` | 401 | No — check the token |
| `forbidden` | 403 | No — add the scope |
| `identity_mismatch` | 403 | No |
| `unverified_sender` | 403 | No — configure the address or pin the token |
| `not_found` | 404 | No |
| `rejected_by_relay` | 422 | No — the relay refused this message, see `detail` |
| `rate_limited` | 429 | Yes, after `retry_after` seconds |
| `budget_exceeded` | 429 | Yes, after UTC midnight |
| `storage_failed` / `attachment_unavailable` | 500 | Yes — with the same idempotency key |

Treat any `5xx` as retryable and keep the idempotency key: that combination is how
you get exactly-once sending over an unreliable network.
