# Changelog

Notable user-facing changes to JMail.

## 2026-08-09

### Added

- **Passkey sign-in** — log in with Touch ID, Windows Hello, or a security key (FIDO2/WebAuthn); manage passkeys under Settings → Security
- **Full-text search** across subjects, message bodies, and addresses
- **Conversations** — replies are threaded and shown together in the email view
- **Drafts and scheduled send** — save drafts, or pick a time and mail is delivered automatically
- **Reply with quote and forwarding**, with original attachments included on forwards
- **Archive and labels** — keep the inbox clean, tag mail, and browse by label from the sidebar
- **Contacts** — address book with autocomplete in Compose; people you write to are added automatically
- **Delivery status on sent mail** — Delivered / Opened / Bounced badges
- **Push notifications** — get notified of new mail on any device; installable as an app (PWA)
- **Remote image blocking** — tracking-pixel protection with per-email reveal
- **Backups** — download any message as `.eml` or export the whole mailbox as mbox
- **Dark mode** — light, dark, or follow-system, switchable from the sidebar
- **Dashboard** — daily activity chart, recent messages, system status, and storage usage
- Optional **R2 storage for attachments**, raising the per-file limit from 5MB to 25MB

### Changed

- Redesigned interface: new inbox with date groups, sender avatars, message previews, and quick actions on hover; floating compose button; refreshed compose, settings, and login screens

### Security

- Hardened session handling, sanitized rendering of received HTML, stricter security headers, and rate-limited sign-in attempts

## 2026-10-29

JMail becomes a mail server: the same deployment now serves mail to your other
projects, still without costing anything.

### Added

- **Mail-server API** — `/api/v1/send`, `/messages`, `/messages/:id` (+ attachment
  and `.eml` downloads), `/read`, `/quota`, `/whoami`, authenticated with bearer
  tokens instead of a session
- **Project tokens** — scoped (`send` / `read` / `status`), each with its own rate
  limit (1–120/min) and daily budget (1–5000), an optional pinned From address, and
  a hash-at-creation secret shown once
- **Relay pool with quota-aware failover** — Brevo (300/day) and Resend (100/day) on
  the free tiers; a relay that errors or runs out hands the send to the next one,
  and when every relay is spent the message is deferred rather than rejected
- **Persistent send queue** — the 5-minute cron drains due sends with exponential
  backoff (30s → 24h, 10 attempts) and retries webhook deliveries on their own ladder
- **Outbound webhooks** — HMAC-signed delivery events (`t=…,v1=…`) to any endpoint of
  yours, with an SSRF guard on the target and per-endpoint delivery rows
- **Idempotency keys** — a retried `POST /api/v1/send` replays the original message
  (`deduplicated: true`) instead of sending twice, so a flaky integration is safe to retry
- **SMTP bridge** — `scripts/smtp-bridge.mjs` gives apps that only speak SMTP a
  localhost `2525` listener that converts to the API, with SMTP-correct 4xx/5xx
  failures so a fronting MTA retries what it should
- **`SETUP_CODE` deploy secret** — closes the window where the first visitor to a
  fresh workers.dev URL could claim the deployment
- **Mail server screen** — Sending relays / Project tokens / Webhooks tabs, with
  per-relay daily counters, quota overrides and failover order
- **Documentation for integrators** — `docs/SETUP.md` (free-tier runbook), 
  `docs/INTEGRATIONS.md` (Node, Python, PHP, SMTP, CI recipes), `docs/openapi.yaml`,
  plus rewritten `docs/API.md` and `docs/WEBHOOKS.md`
- **Persian documentation** — `docs/fa/` mirrors the same four documents sentence for
  sentence (`README.md` index and glossary, `SETUP.md`, `API.md`, `INTEGRATIONS.md`,
  `WEBHOOKS.md`); commands, JSON keys, limits and code samples stay byte-identical to
  the English originals, which remain the technical reference
- **Tests without a framework** — 107 checks (96 worker + 11 frontend) covering the
  send queue and its claims, tokens, login limits, inbound storage bounds, webhook
  signing and the SMTP bridge over a real socket; the queue-locking SQL runs on
  `node:sqlite` and the inbound checks parse real MIME with postal-mime

### Changed

- `emails.mailgun_id` is now `emails.provider_message_id` — it holds whichever relay
  answered, not a Mailgun id (migration `005-provider-message-id.sql`)
- Removed configuration that was never read (`JWT_SECRET`) and the unused
  `MailgunAPI` / `MailtrapAPI` export aliases
- Install guides and the agent runbook describe this repository, not the upstream
  QMail product
- Both drains now take a **lease** on the row they are working on before touching
  the network, so an overlapping cron tick — or the 5-minute cron firing while a
  `/api/v1/send` request is still in flight — cannot post the same message twice;
  a drain that dies mid-send leaves the row retryable instead of stranded
- Received mail is bounded where it is stored (body, subject, header set and
  attachment count); anything over the limit is kept, truncated and labelled in
  the message rather than silently dropped
- Removed settings rows no code ever read (`api_rate_limit_per_min` and quotas for
  relays that were never wired up) and the two that duplicated a relay's own
  free-tier number; daily caps come from the provider registry and stay overridable
  (migration `006-drop-dead-settings.sql`)
- Corrected four documentation claims found while mirroring them into Persian: the
  verification query in `docs/SETUP.md` §13 used two `emails` columns that do not
  exist (`received_at`, `direction` → `created_at`, `type`), `wrangler tail` was
  shown with an `--env=production` this deployment has no, `docs/API.md` §2 promised
  a fallback From address the API does not apply, §3 implied outbound mail returns
  bodies, and §6 implied the Resend monthly cap is enforced by default (it is only
  enforced once you set `provider_quota_resend_month`)

### Fixed

- The setup wizard no longer insists on Brevo — a Resend-only installation can
  finish, and completion reports "a sending relay" instead of a specific vendor
- Saving a Brevo key under **Mail server → Sending relays** registers the delivery
  webhook the way the wizard already did, so badges work without re-running setup
- Five `401`s no longer lock you out of your own mail: a successful login clears
  the attempts before it, so the budget guards strangers rather than the owner
- Inbound mail whose attachments were too large to store keeps its Cc recipients,
  and the note about what was dropped now appears in the HTML part as well as the text
- Passkey challenges are consumed in one statement, so two verifications of the
  same challenge can no longer both be told they passed

### Security

- API tokens are stored as SHA-256 hashes and only the prefix is ever displayed
- Outbound headers are allow-listed (`X-*` plus reply-to / in-reply-to / references)
  and CR or LF in a value is rejected, so a caller cannot inject headers
- Webhook targets are refused when they resolve to private or loopback addresses
- Cross-origin writes are rejected, and no read endpoint returns a secret:
  `settings` keys are masked, webhook signing keys are truncated to their first
  characters, and API tokens are shown once at creation and stored hashed
- Sign-in throttling keys on `request.cf.clientIp`, which a client cannot forge,
  instead of a `cf-connecting-ip` header an attacker controls
- Passkey ceremonies accept the deployment's own origin, plus a localhost origin
  only when the worker itself is running locally
- A legacy unsalted SHA-256 password hash is replaced by PBKDF2 (100k iterations)
  on the first correct login, so an old installation stops carrying it
- The fallback page served when no assets are deployed now carries the same
  security headers as the app
