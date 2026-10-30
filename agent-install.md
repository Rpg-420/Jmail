---
name: install-jmail
description: >
  Install, deploy, or upgrade JMail — a private mail server on Cloudflare Workers
  (D1 + Email Routing + a free-tier relay pool, Vue 3 SPA) that also exposes a
  token-authenticated mail API for other projects. Use this skill when a user asks
  to install JMail, deploy it to their Cloudflare account, upgrade an existing
  deployment, or troubleshoot a broken install. Covers prerequisites, database
  migration order, wrangler configuration, the SETUP_CODE secret, optional R2
  attachments, and post-deploy configuration through the app UI.
---

# Installing JMail (agent guide)

You are deploying a **single-admin mail system** that runs entirely on the user's
Cloudflare account and costs nothing to run:

- **Receiving** — Cloudflare Email Routing (free) sends every message at the domain
  to an Email Worker, which stores it in D1.
- **Sending** — a Worker cannot speak SMTP and Cloudflare's own Email Sending is
  paid, so outbound goes through a pool of free transactional relays (Brevo 300/day,
  Resend 100/day) with quota-aware failover. A send whose relays are all spent is
  **deferred**, not lost: the cron retries it.
- **Storage** — one D1 SQLite database; attachments optionally in R2.
- **For other projects** — API tokens guard `/api/v1/*` (send, read inbound, status,
  quota), and HMAC-signed webhooks push delivery events to the user's apps.
  `scripts/smtp-bridge.mjs` adds a localhost SMTP front-end for anything that can
  only do SMTP.
- **Frontend** — a Vue 3 SPA served as static assets by the same Worker.

Read this whole file before running commands. The steps are ordered; the migration
section especially must not be improvised.

## What the user must have (verify before starting)

| Requirement | How to verify | If missing |
|---|---|---|
| Cloudflare account | `npx wrangler whoami` after login | User creates one at dash.cloudflare.com (free tier works) |
| A domain usable for email | Ask the user | Domain must be (or become) a Cloudflare zone |
| A sending relay | Ask the user | One free key is enough (brevo.com or resend.com); both gives failover. Keys are entered in the app, never in config files |
| Node.js ≥ 22.12 | `node --version` | Root `package.json` `engines` requires it |
| pnpm | `pnpm --version` | `npm install -g pnpm` |

Notes for the agent:

- **wrangler does NOT need a global install** — the repo pins it and every command
  below uses `npx wrangler`.
- `wrangler login` opens a browser OAuth flow. You cannot complete it for the user;
  ask them to run it themselves, then verify with `npx wrangler whoami`.
- The **Cloudflare API token and relay keys are configured inside the app after
  deployment**, not during install. Do not ask the user to paste them into config
  files or into the chat; the app stores them in D1 and masks them in API responses.
- **`SETUP_CODE` is the one deploy secret.** It gates the "create the admin password"
  step so a stranger cannot claim the deployment first. Ask the user to choose it.
- **Never commit `wrangler.toml`** — it is gitignored on purpose because it contains
  the account-specific database id.

## Fresh install

Run from the repository root unless stated otherwise. Several `wrangler d1`
commands are directory-sensitive — **always run them from `packages/worker/`**.

### 1. Install dependencies

```bash
cd <the jmail checkout>
pnpm install
```

### 2. Create the D1 database

```bash
cd packages/worker
npx wrangler d1 create jmail-db
```

Capture the `database_id` UUID from the output. If the command says the database
already exists, get the id with `npx wrangler d1 list` instead — do not create a
second one.

### 3. Configure wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

Then edit `wrangler.toml` and replace `YOUR_DATABASE_ID_HERE` with the UUID from
step 2. Leave everything else as-is. The file already includes:

- `name = "jmail"` — the Email Routing catch-all targets the Worker **by name**, so
  a different name must be corrected in the app (see step 8).
- `[assets]` with `binding = "ASSETS"` and `run_worker_first = true` — required for
  SPA deep links and security headers; do not remove them.
- `[triggers] crons = ["*/5 * * * *"]` — drains the send queue, delivers scheduled
  mail, retries webhook deliveries and prunes expired sessions. Keep it.
- A commented-out `[[r2_buckets]]` block — see "Optional: R2" below. Leave it
  commented unless the user has R2 enabled.

### 4. Initialize the database schema

Fresh installs use `schema.sql` and **nothing else**:

```bash
npx wrangler d1 execute jmail-db --remote --file=./src/db/schema.sql
```

Do **not** run anything in `src/db/migrations/` on a fresh database — those are
upgrade deltas for pre-existing databases and will fail (or worse, no-op
misleadingly) on a fresh one.

Sanity check — this must list `emails`, `attachments`, `contacts`, `credentials`,
`challenges`, `push_subscriptions`, `folders`, `emails_fts`, `api_tokens`,
`provider_usage`, `token_usage`, `webhook_endpoints` and `webhook_deliveries`:

```bash
npx wrangler d1 execute jmail-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### 5. Set the setup secret

```bash
npx wrangler secret put SETUP_CODE
```

The workers.dev URL is public the moment it deploys, and the first caller to post a
password becomes the admin. `SETUP_CODE` closes that window: while the secret exists,
`/auth/setup` rejects any request whose `setupCode` doesn't match it (compared
timing-safely). It is optional — unset it and local development stays simple — but for
anything reachable from the internet, set it. The wizard asks for it once; after the
admin password is stored, `/auth/setup` answers `Already setup` for every later caller
and the secret has done its job.

Sessions need no signing secret — each login mints a random 48-byte token and stores
only its SHA-256 hash, so a redeploy never signs anyone out.

### 6. Build everything

From the repository root (this builds the two API wrapper packages AND the frontend
— the worker will not deploy correctly without them):

```bash
cd ../..
pnpm -r build
```

Expected: tsup output for `@jmail/brevo-api` and `@jmail/cloudflare-email-api`, then
a Vite build ending in `✓ built`.

### 7. Deploy and verify

```bash
cd packages/worker
npx wrangler deploy
```

Expected output includes the workers.dev URL (e.g.
`https://jmail.<subdomain>.workers.dev`), bindings for `env.DB` and `env.ASSETS`,
and `schedule: */5 * * * *`. Then all of these must pass before telling the user it
works:

```bash
BASE="https://jmail.<their-subdomain>.workers.dev"
curl -s  $BASE/api/health                          # → {"status":"ok",...}
curl -s  $BASE/api/auth/status                     # → {"authenticated":false,"needsSetup":true,...}
curl -so /dev/null -w "%{http_code}" $BASE/login   # → 200 (SPA deep link)
curl -sI $BASE/ | grep -i content-security-policy  # → CSP header present
```

If `/login` returns the "Frontend assets not found" page, the frontend was not built
before deploy — redo steps 6–7.

### 8. In-app configuration (the user does this in a browser)

The rest happens in the app. Walk the user through it; you cannot do these steps for
them because they involve their credentials and email verification. `docs/SETUP.md`
is the human-facing version of this list, including the DNS tables.

1. **Open the deployed URL** → the setup wizard appears. Step 1 is the admin
   password (min 8 chars) plus `SETUP_CODE`. They are signed in automatically.
2. **Cloudflare API token + Account ID + domain.** The user creates the token at
   dash.cloudflare.com → My Profile → API Tokens → Create Custom Token with:

   | Scope | Permission | Access |
   |---|---|---|
   | Zone | Zone | Read |
   | Zone | DNS | Edit |
   | Zone | Email Routing Rules | Edit |
   | Zone | Email Routing Destinations | Edit |
   | Zone | Zone Settings | Edit |
   | Zone | Zone | Edit — only if the zone must be created |

   Account ID is on the right-hand side of any zone page. This step adds the zone if
   needed, enables Email Routing, reads the records Cloudflare requires and sets the
   catch-all rule to **route to Worker → `jmail`**.

   ⚠️ If the Worker was deployed under a name other than `jmail`, the catch-all
   targets the wrong Worker — the "Fix Email Routing" button in
   **Settings → Cloudflare** accepts the actual name
   (`POST /api/setup/cloudflare/worker-routing` with `{"workerName": "..."}`,
   authenticated with the session token).

3. **Sending relay** — the wizard offers Brevo (300/day) or Resend (100/day); the
   user picks one and pastes that key. JMail verifies it before saving, so a typo is
   caught here rather than in the cron. Connecting Brevo also registers the
   delivery-status webhook. Add the second relay later under **Mail server →
   Sending relays** if they want failover; re-saving a key there re-registers the
   webhook too.
4. **Complete setup** — the wizard will not close until Cloudflare *and* one relay
   are configured, and it reports exactly which of those are still missing.
5. **Sending addresses** — the `name@theirdomain` identities to send *as*, under
   Settings → Addresses. Catch-all means every local part already receives.
6. **DNS records for sending** — SPF/DKIM/DMARC for the relay at the domain. JMail
   shows what Cloudflare's Email Routing needs; the relay's dashboard shows its own
   DKIM. One SPF record per hostname, never two. See `docs/SETUP.md` §8.
7. **Test both directions**: mail from any external mailbox to
   `anything@theirdomain.com` must appear in the Inbox; send one out via Compose and
   confirm the badge moves to Delivered (that badge needs the delivery webhook, which
   connecting the relay in step 3 sets up).
8. **Give a project mail access** — **Mail server → Project tokens** → create a token
   with `send`, then hand the project `POST /api/v1/send` with `Authorization: Bearer`.
   `docs/INTEGRATIONS.md` has copy-paste clients for Node, Python, PHP, SMTP-only apps
   and CI.

## Optional: R2 for large attachments

Default behavior without R2: attachments are stored base64-inline in D1 with a
**5 MiB per-file cap**. With R2 the cap is **25 MiB** and the database stays small.

R2 must first be **enabled by the user in the Cloudflare dashboard** (one-time
opt-in; the API returns error code `10042` if it isn't). Then:

```bash
cd packages/worker
npx wrangler r2 bucket create jmail-attachments
```

Uncomment the `[[r2_buckets]]` block in `wrangler.toml` and redeploy. Existing inline
attachments keep working — reads fall back to D1 automatically.

## Upgrading an existing deployment

Order matters. `002`–`004` are additive and idempotent; `002` rebuilds tables and
**must never run twice**; `005` is a one-shot column rename.

1. `git pull` and `pnpm install`.
2. Figure out the database's generation:
   ```bash
   npx wrangler d1 execute jmail-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
   # the stored DDL shows which relay-id column the table actually has:
   npx wrangler d1 execute jmail-db --remote --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='emails'"
   # and whether the settings seeds still carry the rows nothing reads:
   npx wrangler d1 execute jmail-db --remote --command "SELECT key FROM settings WHERE key IN ('api_rate_limit_per_min','provider_quota_mailjet_day','provider_quota_smtp2go_month','provider_quota_brevo_day','provider_quota_resend_day')"
   ```
   - No `credentials` table → first run `schema.sql` (idempotent), then
     `migrations/002-features.sql`.
   - `credentials` exists but no `push_subscriptions`/`emails_fts` → run
     `migrations/002-features.sql` only.
   - `push_subscriptions` exists but no `contacts` → run `schema.sql` (it is fully
     idempotent and only adds what's missing).
   - `contacts` exists but no `folders` → `migrations/003-folders.sql`.
   - `folders` exists but no `api_tokens` → `migrations/004-mail-server.sql`. Without
     it the web app works but the Mail server screens and `/api/v1` answer nothing.
   - `api_tokens` exists but `emails` still has `mailgun_id` →
     `migrations/005-provider-message-id.sql`, then `006-drop-dead-settings.sql`.
   - `provider_message_id` present but `settings` still holds `api_rate_limit_per_min`
     or a `provider_quota_mailjet_*` / `provider_quota_smtp2go_*` row →
     `migrations/006-drop-dead-settings.sql` (nothing reads those keys; the migration
     just prunes them).
   - `provider_message_id` present and no dead settings rows → schema is current.
3. **Never run `002-features.sql` twice** — it rebuilds tables and will fail on an
   already-migrated database (D1 rolls the batch back, so a failed re-run is harmless
   but alarming).
4. `pnpm -r build` from the root, then `npx wrangler deploy` from `packages/worker/`.
5. Tell the user: upgrading from a pre-passkey version **invalidates existing
   sessions** (tokens are now stored hashed) — they just sign in again with the same
   password. API tokens are unaffected; projects keep working.

## Local development (only if the user asks for it)

```bash
# Terminal 1 — worker + local D1 (state lives in packages/worker/.wrangler/)
cd packages/worker
npx wrangler d1 execute jmail-db --local --file=./src/db/schema.sql
npx wrangler dev            # serves on http://localhost:8787

# Terminal 2 — optional Vite dev server with HMR (proxies /api to :8787)
cd frontend
pnpm run dev                # serves on http://localhost:5173
```

Tests, no framework required:

```bash
pnpm test                    # 107 checks: 96 worker + 11 frontend
                             # relays, send queue, queue claims, inbound limits,
                             # /api/v1, webhooks, login limits, setup gate,
                             # SMTP bridge, PWA, RTL
```

Gotchas you will hit if you're careless:

- `wrangler d1 ... --local` is **cwd-sensitive** — run it from `packages/worker/` or
  it errors with "Couldn't find a D1 DB".
- The local D1 file is keyed by `database_id`; changing the id in `wrangler.toml`
  silently gives you a fresh empty local database.
- If port 8787 is taken by a zombie dev server: `lsof -ti :8787 | xargs kill -9`.
- Test the cron locally with `npx wrangler dev --test-scheduled`, then
  `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Frontend assets not found" page | Frontend not built before deploy, or `[assets]` block missing `binding = "ASSETS"` | `pnpm -r build`, check wrangler.toml, redeploy |
| Deploy error mentioning `jmail-attachments` | R2 block uncommented but bucket/R2 not enabled | Re-comment the `[[r2_buckets]]` block or create the bucket |
| API error code `10042` on bucket create | R2 not enabled on the account | User enables R2 in the Cloudflare dashboard first |
| Inbound mail never arrives | Catch-all rule not pointing at the worker, or DNS/MX not active | Settings → Cloudflare → "Fix Email Routing"; verify MX records and zone is active |
| Outbound stuck at `deferred` | No relay key, or every relay's daily quota is spent | Add a key in Mail server → Sending relays, or raise the daily quota; queued mail sends itself |
| Outbound refused / spam-foldered | Sending domain unverified at the relay | Complete SPF/DKIM/DMARC verification there |
| No Delivered/Opened badges | Delivery webhook was never registered | Re-save the relay key in Sending relays; that call (re)registers it |
| `/api/v1/*` returns 401/403 | Token revoked, scope missing, or rate limit | **Mail server → Project tokens**: check scopes; 429 carries `retry_after` |
| Mail server screens empty, `/api/v1` answers nothing | `004-mail-server.sql` never applied on an older database | Apply it, then redeploy |
| 429 on login | Rate limit: 5 attempts / 15 min (password + passkey share it) | Wait 15 minutes |
| "Too many setup attempts" | Setup rate limit: 3 / hour | Wait an hour |
| Everyone logged out after upgrade | Session tokens now stored hashed | Expected — sign in again |
| Passkey works on workers.dev but not custom domain | Passkeys bind to hostname | Register an additional passkey on the new hostname |
| Migration file fails mid-run | Wrong generation or ran twice | D1 rolls back the batch; re-check the generation table in "Upgrading" |

## Facts about the system worth stating to users

- All service credentials (Cloudflare token, relay keys, the relay webhook secret)
  live in the D1 `settings` table, entered through the UI over HTTPS — nothing secret
  goes in config files, and those values are masked in every API response. Per-hook
  signing keys live in `webhook_endpoints`, and API tokens are stored only as hashes.
- API tokens are stored as SHA-256 hashes. The plaintext is shown once at creation;
  losing it means issuing a new token, not recovering it.
- Received HTML email is DOMPurify-sanitized and remote images are blocked by default
  (Settings → Security → Privacy).
- Push notifications are payload-free by design: the push service only ever learns
  "something arrived", never any mail content.
- Full backup anytime: Settings → Security → Backup → mbox export, or
  `wrangler d1 export jmail-db --remote`.
- Nothing here costs money: Workers, D1, Email Routing and R2 are inside the free
  tier, and the relays are on theirs. The daily caps are enforced locally so a
  project's runaway script cannot turn into a bill.
- A message is posted once: every queue row is claimed with a ten-minute lease
  before a relay is contacted, so overlapping cron ticks — or a tick racing an
  in-flight `/api/v1/send` — cannot double-send.
