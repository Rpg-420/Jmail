# JMail

**فارسی:** مستندات کامل به فارسی در [docs/fa/](docs/fa/README.md) (نصب، مرجع API، اتصال پروژه‌ها، وب‌هوک).

JMail is the project name throughout the app, workspace packages, notifications and exports.
Repository: https://github.com/Rpg-420/Jmail — a personal fork of [QMail](https://github.com/DevURANIUM/QMail) (MIT), extended into a mail server other projects can call.
The production Worker is `jmail`; deployment preserves its existing D1 binding.

Self-hosted email on your own domain, running entirely on Cloudflare's edge.

Receive mail through **Cloudflare Email Routing**, store it in a **D1** database
(attachments optionally in **R2**), send through a pool of free transactional
relays (**Brevo** and **Resend**, quota-aware failover and a persistent retry
queue), and manage everything from a **Vue 3** web app served by the same
Worker. One deploy, no servers, and it costs nothing on the free tier.

The same Worker also acts as the **mail server for your other projects**: issue
each project an API token, and it sends, reads, and checks delivery over plain
HTTPS (`/api/v1`) — no postfix on any box. Signed outbound webhooks push status
to your apps, and an optional SMTP bridge covers the projects that only know how
to speak SMTP.

> 📖 Set it up: [`docs/SETUP.md`](./docs/SETUP.md) · Connect a project:
> [`docs/INTEGRATIONS.md`](./docs/INTEGRATIONS.md) · Endpoint reference:
> [`docs/API.md`](./docs/API.md) · [`docs/openapi.yaml`](./docs/openapi.yaml) ·
> Webhooks: [`docs/WEBHOOKS.md`](./docs/WEBHOOKS.md)

> 🤖 Installing with an AI agent (Claude Code, etc.)? Point it at
> [`agent-install.md`](./agent-install.md) — a step-by-step install guide written for agents.

## Features

**Mail**

- Catch-all receiving on your domain — every address at your domain lands in one inbox
- Sending through free relays with quota-aware failover: a saturated day defers mail instead of losing it
- Delivery tracking (delivered / opened / bounced / deferred) reported back by relay webhook
- Conversation threading via `Message-ID` / `In-Reply-To` headers
- Drafts, reply-with-quote, forwarding (original attachments included), and scheduled send (cron-delivered)
- Archive, labels, starring, and full-text search (SQLite FTS5 over subjects, bodies, and addresses)
- Attachments up to 5MB/file in D1, or 25MB/file with an optional R2 bucket
- Received mail is bounded as it is stored (1 MB text, 2 MB HTML, a 998-character subject, 256 KB of headers, 25 files) and the message itself says what was trimmed
- Contacts with autocomplete in Compose — people you write to are captured automatically
- Per-message `.eml` download and whole-mailbox **mbox export**
- Optional forwarding of received mail to a personal inbox as backup
- Telegram forwarding through your own bot to a private numeric user ID, with a test message and delivery status

**Mail server for your other projects**

- `/api/v1` HTTP API: send, list, read, download, and check status — bearer tokens, no SMTP
- Per-project tokens with scopes (`send` / `read` / `status`), a per-minute rate limit, and a daily budget
- Identity pinning, so a token can only send as its own address, plus header-injection filtering
- Idempotency keys: a retried `POST /send` returns the original message instead of sending twice
- A persistent send queue with exponential backoff, drained by cron (30s → 24h, ten attempts)
- Queue rows are claimed with an expiring lease, so overlapping cron ticks never post the same mail twice
- HMAC-signed outbound webhooks (`sent`, `delivered`, `opened`, `bounced`, `deferred`, `failed`, `received`) with per-endpoint retry ladders
- `GET /api/v1/quota` so a project can see the room left before it starts a run
- [`scripts/smtp-bridge.mjs`](./scripts/smtp-bridge.mjs) — an SMTP front-end for WordPress, Laravel, PHP `mail()`, Postfix, or anything else that cannot make an HTTP call
- OpenAPI 3.1 spec and per-language client code (curl, Node, Python, PHP, Go-friendly)

**App**

- Vue 3 SPA with full light / dark / system theming
- Dashboard: daily send/receive activity chart, recent messages, system status, storage usage
- Installable PWA with payload-free push notifications on new mail
- Remote-image blocking (tracking-pixel protection) with per-email reveal

**Security**

- Passkey sign-in (FIDO2/WebAuthn) — Touch ID, Windows Hello, security keys — plus a password fallback
- PBKDF2 password hashing (100k iterations), session and API tokens stored as SHA-256 hashes
- Deploy-time `SETUP_CODE` gate, so a public workers.dev URL cannot be claimed by the first visitor
- Received HTML sanitized with DOMPurify before rendering
- Strict Content-Security-Policy and security headers on every response
- Shared rate limit for password and passkey login attempts; cross-origin mutations rejected
- SSRF guard on webhook URLs — private and link-local addresses are refused
- Server-side attachment validation, safe download headers, sanitized filenames

## Architecture

```
                          Cloudflare Edge
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Email Routing ──▶ Email Worker ──┬─▶ D1 (mail, contacts,        │
│   (catch-all, free)               │      settings, sessions,     │
│                                   │      queue, tokens, FTS)     │
│  Cron (*/5) ──▶ send queue ───────┤                              │
│               webhook deliveries ─┤─▶ R2 (attachments, optional) │
│                                   │                              │
│  HTTPS ──▶ Worker (Hono API) ─────┤                              │
│            ├── /api/* (session)   │                              │
│            ├── /api/v1/* (tokens) ── other projects, curl, CI    │
│            └──▶ Vue 3 SPA (static assets)                        │
│                                                                  │
└──────────────┬───────────────────────────────┬───────────────────┘
               │ send (failover by quota)      │ delivery + inbound events
               ▼                               ▼
        Brevo ⇄ Resend ──▶ relay webhook ──▶ your endpoints (HMAC-signed)
```

  Browser ◀── Web Push (VAPID, no payload) ── Email Worker

Cloudflare cannot *send* mail on the free tier — a Worker has no port 25/465/587,
and Cloudflare Email Sending is paid. So inbound lives entirely on Cloudflare,
and outbound is handed to relays whose free HTTPS APIs JMail pools, counts, and
fails over between. If you configure no relay at all, receiving and the queue
keep working and nothing is lost.

## Quick start

**Prerequisites**: a Cloudflare account with a domain whose nameservers you can
change, at least one free relay account (Brevo, or Resend, or both), Node.js
22.12+, and pnpm.

The long version, including DNS records and troubleshooting, is
[`docs/SETUP.md`](./docs/SETUP.md).

```bash
# 1. Clone and install
git clone https://github.com/Rpg-420/Jmail.git JMail
cd JMail
pnpm install

# 2. Authenticate wrangler
npx wrangler login

# 3. Create the database
cd packages/worker
npx wrangler d1 create jmail-db          # note the database_id in the output

# 4. Configure
cp wrangler.toml.example wrangler.toml     # then paste your database_id into it

# 5. Initialize the schema (fresh installs only — see Upgrading otherwise)
npx wrangler d1 execute jmail-db --remote --file=./src/db/schema.sql

# 6. Gate the first-run setup screen (the workers.dev URL is public immediately)
npx wrangler secret put SETUP_CODE

# 7. Build and deploy
cd ../..
pnpm build
npx wrangler deploy
```

Your app is now live at `https://jmail.<your-subdomain>.workers.dev`.

### First-run configuration (in the app)

Open the URL and follow the setup wizard; it is the same surface as the Settings
screens, and each step verifies itself before saving.

1. **Admin password** — plus the `SETUP_CODE` you set above. Optionally add a
   **passkey** under Settings → Security afterwards.
2. **Cloudflare** — create an API token
   ([dash.cloudflare.com → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
   → Create Custom Token) with these permissions, then enter it with your
   Account ID and domain:

   | Scope | Permission | Access |
   |---|---|---|
   | Account | Email Routing Addresses | Edit |
   | Zone | Zone | Read |
   | Zone | DNS | Edit |
   | Zone | Email Routing Rules | Edit |
   | Zone | Zone Settings | Edit |

   Saving enables Email Routing on your zone and points the catch-all rule at
   the worker. If inbound mail ever stops, the **Fix Email Routing** button
   re-applies the rule.
3. **Relays** — paste a Brevo API key
   ([app.brevo.com → SMTP & API](https://app.brevo.com/settings/keys/api)) and /
   or a Resend one ([resend.com/api-keys](https://resend.com/api-keys)). Each
   key is verified against the provider before it is stored, and saving registers
   the delivery-status webhook automatically. **Mail server → Sending relays** shows
   the failover order, the room left today, and lets you override a quota.
4. **Verify your sending domain in the relay** — add the SPF / DKIM / DMARC
   records it gives you. Note that SPF must be a *single* TXT record on `@`
   merged with whatever Email Routing asked for, and DKIM is what keeps Gmail
   out of the spam folder.
5. **Addresses** — add at least one From address.
6. **Complete Setup**, then test both directions: mail an external message to
   `anything@yourdomain.com` and send one out via Compose.

### Giving a project mail access

**Mail server → Project tokens → New token**, then point the project at the API:

```bash
curl -X POST https://jmail.<account>.workers.dev/api/v1/send \
  -H "Authorization: Bearer jmail_xxx" \
  -H "Content-Type: application/json" \
  -d '{"from":"alerts@yourdomain","to":["you@yourdomain"],"subject":"Deploy done","text":"prod is up"}'
```

[`docs/INTEGRATIONS.md`](./docs/INTEGRATIONS.md) has Node / Python / PHP clients,
the SMTP-only bridge, and the inbound-mail patterns.

## Configuration reference

`wrangler.toml` (gitignored; copy from `wrangler.toml.example`):

```toml
name = "jmail"                 # worker name — also the catch-all rule target
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[d1_databases]]
binding = "DB"
database_name = "jmail-db"
database_id = "YOUR_DATABASE_ID_HERE"

[assets]
directory = "../../frontend/dist"
binding = "ASSETS"               # SPA deep links (/inbox, /login, …)
run_worker_first = true          # security headers on every response

# Optional — see "R2 attachments" below
# [[r2_buckets]]
# binding = "ATTACHMENTS"
# bucket_name = "jmail-attachments"

[triggers]
crons = ["*/5 * * * *"]          # send queue, webhook deliveries, housekeeping

[vars]
APP_NAME = "JMail"
WORKER_NAME = "jmail"            # must equal `name`: the routing rule target
```

Secrets and keys are kept out of config files:

| Where | What | Why |
|---|---|---|
| `wrangler secret` | `SETUP_CODE` | only needed to gate the first-run password step |
| D1 `settings` (via the app) | Cloudflare API token, relay keys, webhook secret | change them without redeploying; masked by the settings API |

`JWT_SECRET` is *not* used — sessions and API tokens are random values stored as
SHA-256 hashes in D1, so a redeploy never signs anyone out.

### Custom folders

Use **Folders** in the sidebar to create, rename or delete folders. Select Inbox
or Sent as a source, select messages individually or with **Select page**, choose
a destination and use **Move selected**. Pages contain 50 messages; API batches
are capped at 100. A message belongs to one custom folder; its labels remain intact.
Moving back to Original mailbox restores the message to Inbox or Sent. Deleting
a folder preserves its messages. Drafts and scheduled messages cannot be moved.

Existing installations must apply this additive migration **before deploying**:

```bash
cd packages/worker
npx wrangler d1 execute jmail-db --remote --file=./src/db/migrations/003-folders.sql
```

Fresh installs include these tables in `schema.sql`. No remote migration is
performed automatically.

### Install JMail as an app (PWA)

Open JMail over HTTPS in Chrome or Edge and use **Install JMail** in the
sidebar (also in the mobile menu). When the browser offers native installation,
the button opens its prompt. Otherwise it shows browser-menu instructions.
On iPhone/iPad, use Safari → Share → Add to Home Screen → Add.
The install button is hidden when running in standalone mode.

An offline launch shows a reconnect page. Only that public offline document is
cached: messages, API responses, attachments and login sessions are never added
to the service worker cache. Reading and sending email requires connectivity.
Localhost can be used for development; production installation requires HTTPS.
Browser support and installation prompts vary, including in embedded browsers.

PWA regression checks: `node --test frontend/pwa.test.mjs`.

### Telegram forwarding

Open **Settings → Telegram**. Create a bot with `@BotFather`, enter its token
and the recipient's positive numeric Telegram user ID, enable forwarding and
save. The recipient must first open the bot and press **Start**. Use **Send test
message** after saving to verify delivery. Leave the token blank when editing to
keep the saved token; disable forwarding and save to pause.

The token is stored server-side in D1 like the existing provider credentials and
is masked in API responses. Incoming sender, recipient, subject and plain-text
body are sent to Telegram; HTML-only messages receive a notice to open JMail.
Attachments remain in JMail. Long bodies are limited to 24,000 UTF-16 units and
split into messages below Telegram's size limit. Delivery is best-effort (no
queue/retry); Telegram failures never reject a stored email. Last delivery and
last error appear in Settings. Email content is shared with Telegram when enabled.
No database migration is needed for this integration.

Regression tests: `node --test packages/worker/telegram.test.mjs`.

### R2 attachments (optional)

Without R2, attachments live base64-inline in D1 (5MB per file). To raise the
cap to 25MB and keep the database lean:

1. Enable R2 once in the Cloudflare dashboard (the API errors with code `10042`
   until you do).
2. `npx wrangler r2 bucket create jmail-attachments`
3. Uncomment the `[[r2_buckets]]` block in `wrangler.toml` and redeploy.

Existing inline attachments keep working — reads fall back to D1 automatically.

## Upgrading

Fresh installs use `schema.sql` only. Existing databases apply what they're
missing. `002`–`004` are additive (`CREATE TABLE IF NOT EXISTS`), so re-running
one is harmless; `005` is a one-shot rename — skip it once `emails` already has
`provider_message_id`; `006` deletes rows and re-running it changes nothing:

```bash
cd packages/worker
# pre-passkey installs first bring the base schema up to date:
npx wrangler d1 execute jmail-db --remote --file=./src/db/schema.sql
# threading / drafts / FTS (run ONCE if missing):
npx wrangler d1 execute jmail-db --remote --file=./src/db/migrations/002-features.sql
# custom folders (additive):
npx wrangler d1 execute jmail-db --remote --file=./src/db/migrations/003-folders.sql
# mail-server layer: api_tokens, provider_usage, token_usage, webhook_* (additive):
npx wrangler d1 execute jmail-db --remote --file=./src/db/migrations/004-mail-server.sql
# rename the Mailgun-era column to provider_message_id (run ONCE if missing):
npx wrangler d1 execute jmail-db --remote --file=./src/db/migrations/005-provider-message-id.sql
# drop settings rows no install needs (dead relays, duplicate/unread keys):
npx wrangler d1 execute jmail-db --remote --file=./src/db/migrations/006-drop-dead-settings.sql
```

Without `004`, the web app works but the Mail server screens and `/api/v1` answer
nothing — the token, quota and webhook tables are what those features read.
Without `005`, sends, delivery webhooks and the sent-mail badges keep working;
only the column name is older than the code that reads it.

Unsure which generation you're on? `agent-install.md` has a decision table keyed off
which tables exist. After migrating: `pnpm build` and `npx wrangler deploy`.

Upgrading from a pre-passkey version signs everyone out once (session tokens
are now stored hashed) — just log in again.

## Development

```bash
# Terminal 1 — worker + local D1 on :8787
cd packages/worker
npx wrangler d1 execute jmail-db --local --file=./src/db/schema.sql
npx wrangler dev

# Terminal 2 — Vite dev server with HMR on :5173 (proxies /api to :8787)
cd frontend
pnpm run dev
```

Test the cron locally: start with `npx wrangler dev --test-scheduled`, then
`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.

### Project structure

```
JMail/
├── frontend/                  # Vue 3 SPA (Vite, Tailwind, Pinia)
│   ├── public/                # PWA manifest, service worker, theme bootstrap
│   └── src/
│       ├── api/               # typed API client
│       ├── components/        # EmailList, ActivityChart
│       ├── stores/            # auth, emails, theme
│       ├── utils/             # avatar helpers
│       └── views/             # Dashboard, Inbox, EmailView, Compose, Drafts,
│                              # Archive, Contacts, Settings, MailServer, …
├── packages/
│   ├── worker/                # Cloudflare Worker (Hono)
│   │   ├── src/
│   │   │   ├── api/           # auth, webauthn, emails, contacts, folders, push,
│   │   │   │                  # settings, setup, webhooks (inbound),
│   │   │   │                  # tokens, providers, hooks, v1 (mail-server API)
│   │   │   ├── db/            # schema.sql, migrations/, queries.ts
│   │   │   ├── lib/           # mailer + queue, providers/ (brevo, resend),
│   │   │   │                  # webhooks-out, backoff, attachments (R2/D1),
│   │   │   │                  # push (VAPID), eml builder, rate limiting, validation
│   │   │   ├── email-handler.ts   # inbound mail: parse, thread, store, notify
│   │   │   └── index.ts           # fetch + email + scheduled entrypoints
│   │   └── test/              # node:test suites over the real TS source
│   ├── brevo-api/             # Brevo REST wrapper (send, senders, webhooks)
│   └── cloudflare-email-api/  # Cloudflare REST wrapper (zones, routing, DNS)
├── scripts/
│   ├── smtp-bridge.mjs        # SMTP front-end for /api/v1 (no dependencies)
│   └── verify-jmail-upgrade.py
├── docs/                      # SETUP, API, INTEGRATIONS, WEBHOOKS, openapi.yaml
└── agent-install.md           # agent-oriented install guide
```

### Tests

```bash
pnpm test                     # 107 checks: 96 worker + 11 frontend
                              # relays, send queue, queue claims, inbound limits,
                              # /api/v1, webhooks, login limits, setup gate,
                              # SMTP bridge, PWA, RTL
```

They run under plain `node --test` against the real TypeScript modules (a
`module.registerHooks` transpile hook plus an in-memory D1 stub) — no test
framework, no network, no Cloudflare account. The queue-claim checks use
`node:sqlite` so the locking SQL runs on a real SQLite engine, the inbound-limit
checks feed real MIME messages through postal-mime, the SMTP-bridge suite spawns
the real bridge and speaks SMTP to it over a socket, and the frontend checks
compile the components they cover.

## API reference

All endpoints are under `/api`. `/api/v1/*` takes a **mail-server token**
(`Mail server → Project tokens`); every other private route takes the **session token**
the web app got from login. Public surface: `/health`, the login and setup
ceremonies, and the relay's delivery webhook (secret in the path).

Details, examples and status codes: [`docs/API.md`](./docs/API.md) and
[`docs/openapi.yaml`](./docs/openapi.yaml).

### Auth

| Endpoint | Method | Description |
|---|---|---|
| `/auth/status` | GET | Auth state, `needsSetup`, `hasPasskeys` |
| `/auth/setup` | POST | Create the admin password (first run) |
| `/auth/login` | POST | Password login (rate limited: 5 / 15 min) |
| `/auth/logout` | POST | Invalidate the session |
| `/auth/change-password` | POST | Change password |
| `/auth/webauthn/register/options` · `/verify` | POST | Passkey registration ceremony |
| `/auth/webauthn/login/options` · `/verify` | POST | Passkey login ceremony (shares the login rate limit) |
| `/auth/webauthn/credentials` | GET | List passkeys |
| `/auth/webauthn/credentials/:id` | DELETE | Remove a passkey |

### Mail

| Endpoint | Method | Description |
|---|---|---|
| `/emails` | GET | List (`type=received\|sent\|draft\|scheduled`, `archived`, `label`, `unread`, `starred`, `limit`, `offset`) |
| `/emails/search` | GET | Full-text search (`?q=`) |
| `/emails/labels` | GET | All labels in use |
| `/emails/stats` | GET | Counts + storage usage |
| `/emails/activity` | GET | Daily send/receive counts (`?days=14`) |
| `/emails/export/mbox` | GET | Whole-mailbox mbox download |
| `/emails/drafts` | POST | Create or update a draft |
| `/emails/send` | POST | Send — supports `draftId`, `scheduleAt`, `replyToEmailId`, `forwardOfEmailId`, attachments |
| `/emails/:id` | GET | Single email with attachments + conversation thread |
| `/emails/:id/eml` | GET | Download as `.eml` |
| `/emails/:id/read` · `/unread` · `/star` | POST | Flags |
| `/emails/:id/archive` · `/unarchive` | POST | Archive state |
| `/emails/:id/labels` | PUT | Replace labels |
| `/emails/:id` | DELETE | Delete email + attachments (D1 and R2) |
| `/emails/:id/attachments/:attachmentId` | GET | Download an attachment |

### Contacts, push, folders

| Endpoint | Method | Description |
|---|---|---|
| `/contacts` | GET / POST | List / create (upserts by email) |
| `/contacts/:id` | PUT / DELETE | Update / delete |
| `/folders` | GET / POST | Custom folders |
| `/folders/:id` | PUT / DELETE | Rename / delete (messages are preserved) |
| `/folders/move` | POST | Move selected messages between folders |
| `/push/vapid-key` | GET | VAPID public key |
| `/push/subscribe` · `/unsubscribe` | POST | Manage push subscriptions |
| `/webhooks/brevo/:secret` | POST | Relay delivery events (auto-registered by the wizard; secret in the path) |

### Relays, tokens, webhooks, setup

| Endpoint | Method | Description |
|---|---|---|
| `/providers` | GET | Failover order, quota used and remaining per relay (keys are never returned) |
| `/providers/:id/key` | PUT | Set / replace a relay API key (verified before saving; for Brevo it also (re)registers the delivery webhook) |
| `/providers/:id/quota` | PUT | Override the daily / monthly allowance |
| `/providers/order` | PUT | Reorder failover |
| `/tokens` | GET / POST | List / create mail-server tokens (`secret` is returned once) |
| `/tokens/:id` | PUT | Rename, scopes, rate limit, budget, identity |
| `/tokens/:id/revoke` | POST | Revoke immediately |
| `/tokens/:id/usage` | GET | Per-day sent / failed counts |
| `/hooks` | GET / POST | Outbound webhook endpoints |
| `/hooks/:id` | PUT / DELETE | Update / remove |
| `/hooks/:id/rotate-secret` | POST | New signing secret |
| `/hooks/:id/test` | POST | Send a `test` event now |
| `/hooks/:id/deliveries` | GET | Delivery log with attempts and errors |
| `/settings` | GET / PUT | App settings; sensitive keys are masked |
| `/setup/status` | GET | Configuration state |
| `/setup/cloudflare` | POST | Connect Cloudflare + enable routing |
| `/setup/cloudflare/worker-routing` | POST | Re-point the catch-all at the worker |
| `/setup/brevo` | POST | Connect Brevo + register its webhook |
| `/setup/addresses` | GET / POST / DELETE | Manage From addresses |
| `/setup/complete` | POST | Finish onboarding |

### Mail-server API — what your other projects call

Bearer-authenticated with a token from `Mail server → Project tokens`. See
[`docs/API.md`](./docs/API.md) for fields, limits and every status code, and
[`docs/INTEGRATIONS.md`](./docs/INTEGRATIONS.md) for clients.

| Endpoint | Method | Scope | Description |
|---|---|---|---|
| `/v1/send` | POST | `send` | Send; honours `idempotency_key`, `send_at`, `headers`, `attachments`, `labels` |
| `/v1/messages` | GET | own mail / `read` | List your own outbound (`status`, `idempotency_key`) or inbound (`direction=inbound`, `unread`, `label`) |
| `/v1/messages/:id` | GET | own mail / `read` | Delivery state; inbound also returns body, headers, attachments |
| `/v1/messages/:id/attachments/:attachmentId` | GET | `read` | Attachment bytes (inbound) |
| `/v1/messages/:id/eml` | GET | `read` | RFC 5322 rendering |
| `/v1/messages/:id/read` | POST | `read` | Mark read |
| `/v1/quota` | GET | `status` | Token budget, per-relay room left today, pool total |
| `/v1/whoami` | GET | — | Token identity and scopes |

## Troubleshooting

The longer symptom table in [`docs/SETUP.md`](./docs/SETUP.md#14-troubleshooting)
covers Email Routing, DNS and relay-key problems. The app-specific ones:

| Symptom | Fix |
|---|---|
| "Frontend assets not found" | Build before deploying: `pnpm build`, then redeploy |
| Inbound mail not arriving | Settings → Cloudflare → **Fix Email Routing**; verify MX records and that the zone is active; `npx wrangler tail` to watch the worker |
| Outbound rejected / in spam | Verify the sending domain (SPF/DKIM/DMARC) at the relay — DKIM is the one that matters |
| No delivery badges on sent mail | Re-save the relay API key in Mail server → Sending relays to (re)register its webhook; Resend has no webhook here, so `delivered`/`opened` stay Brevo-only |
| Send sits at `deferred` | Every relay was out of daily quota; it retries itself until 00:00 UTC. Check `GET /api/v1/quota` or Mail server → Sending relays |
| Send shows `failed` with `rejected_by_relay` | The relay refused it permanently (bad address, unverified sender). Fix the cause, then resend from Drafts — the body is preserved |
| `/api/v1/send` answers `401` | Token revoked or mistyped; `GET /api/v1/whoami` with the same key tells you which |
| `/api/v1/send` answers `403 unverified_sender` | Add that address under Settings → Addresses, or pin `identity_address` on the token |
| Mail-server screens are empty | The `004-mail-server.sql` migration was never applied |
| 429 on login | Rate limit — wait 15 minutes (setup: 3/hour) |
| Signed out after upgrading | Expected once (hashed session tokens) — sign in again |
| Passkey missing on a new domain | Passkeys bind to the hostname; add one on the new host |

## License

MIT — see LICENSE.

## Support

Issues and feature requests: [GitHub Issues](https://github.com/Rpg-420/Jmail/issues).
Upstream project this fork builds on: [QMail](https://github.com/DevURANIUM/QMail).
