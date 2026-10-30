# JMail setup — a private mail server on your own domain, for $0

**فارسی:** [docs/fa/SETUP.md](fa/SETUP.md)

This is the complete runbook: from an empty Cloudflare account to a working
mailbox that receives on every address at your domain and sends through free
relays, plus an HTTP mail API your other projects can call.

Nothing here needs a paid plan. The three accounts involved all have free tiers
that cover personal use:

| Service | Free allowance | What it does for you |
| --- | --- | --- |
| Cloudflare Workers + Pages/assets | 100,000 requests/day | Hosts the whole app: API, SPA, inbound mail handler, cron |
| Cloudflare D1 | 5 GB storage, 5M row reads/day | Mailbox, settings, queue, tokens, webhooks |
| Cloudflare Email Routing | Unlimited recipients, free | Inbound mail — it delivers your domain's mail to the Worker |
| Cloudflare R2 (optional) | 10 GB | Attachment storage beyond D1's row size |
| Brevo (relay 1) | 300 emails/day | Outbound sending over their free transactional API |
| Resend (relay 2, optional) | 100 emails/day | Second pool so a saturated day doesn't stop your mail |

**Why a relay at all?** Cloudflare has no way to *send* mail on the free tier —
SMTP is not available from a Worker (no outbound port 25/465/587), and Cloudflare
Email Sending is a paid add-on. So JMail keeps the inbound path entirely on
Cloudflare and hands the outbound path to pooled free HTTPS APIs. You still own
the domain, the addresses, the mailbox, the API, and the data.

If you skip every relay key, JMail still works: received mail lands, the web app
and API work, and outgoing messages sit in the queue as `queued` until a relay is
configured. Nothing is lost.

---

## 0. What you need before starting

- **A domain whose nameservers you can point at Cloudflare.** This is the only
  hard requirement. Email Routing only works on a zone hosted on Cloudflare.
- A Cloudflare account (free).
- [Node.js ≥ 22.12](https://nodejs.org) and [pnpm](https://pnpm.io) (`npm i -g pnpm`).
- A Brevo account (free) — and Resend too if you want a second pool.
- About 20 minutes.

Do step 1–7 on your laptop; the Cloudflare dashboard steps are marked with the
site you're clicking in.

---

## 1. Install the code

```bash
git clone <this repo> jmail
cd jmail
pnpm install
```

## 2. Create the D1 database

```bash
npx wrangler login
npx wrangler d1 create jmail-db
```

Copy the `database_id` from the output. Now create the real config from the
example:

```bash
cp packages/worker/wrangler.toml.example packages/worker/wrangler.toml
```

Edit `packages/worker/wrangler.toml` and put the ID in `database_id`. Leave
`WORKER_NAME = "jmail"` in `[vars]` — the setup wizard uses it to point the
Email Routing catch-all rule at your Worker, and it must equal the `name` field.

If you rename the Worker, rename `name`, `WORKER_NAME`, and `database_name`
together.

## 3. Create the schema

```bash
cd packages/worker
npx wrangler d1 execute DB --remote --file=./src/db/schema.sql
```

The schema is idempotent (`CREATE TABLE IF NOT EXISTS` throughout) — re-running
it after an upgrade is safe and adds any new tables.

## 4. Secrets

One secret, optional but strongly recommended:

```bash
# Gates the "create the admin password" step, so a stranger cannot claim your
# deployment before you do.
npx wrangler secret put SETUP_CODE
```

`SETUP_CODE` is only asked for once, by the setup wizard. The moment the admin
password is stored, `/auth/setup` answers `Already setup` for every later caller,
so the secret has done its job and is harmless to leave in place.

Sessions don't need a signing secret: each login mints a 48-byte random token,
stores only its SHA-256 hash in the D1 `sessions` table with a 7-day expiry, and
revokes all sessions when you rotate the password. Nothing is derived from a
deploy-time key, so a redeploy can never invalidate your logins.

The Worker URL and the relay API keys are **not** deploy secrets; they're stored
in the D1 `settings` table through the web UI, so you can change them without
redeploying.

## 5. Build and deploy

```bash
cd ../..
pnpm build            # builds frontend/dist
pnpm --filter @jmail/worker deploy
```

Note the URL it prints, e.g. `https://jmail.<your-account>.workers.dev` — that's
where you'll open the app. (Later you can put it behind your own hostname; see
§12.)

## 6. First launch: the setup wizard

Open the Worker URL. Because no admin password exists yet, you land on the setup
screen. It asks for, in order:

1. **Admin password + `SETUP_CODE`.** The password is stored as PBKDF2-SHA256
   (100,000 iterations); the plaintext never reaches D1.
2. **Cloudflare API token** and **account ID**, plus your **domain**. Create the
   token at *My Profile → API tokens → Create token* with these permissions:
   - *Zone → Zone → Read* (finds the zone)
   - *Zone → DNS → Edit* (the wizard shows you records to add)
   - *Zone → Email Routing Rules → Edit* (turns routing on, sets the catch-all)
   - *Zone → Email Routing Destinations → Edit* (verifies a forwarding address)
   - *Zone → Zone Settings → Edit* (enables Email Routing)
   - *Zone → Zone → Edit* only if the domain isn't on your account yet — the
     wizard can add the zone.

   Account ID is on the right-hand side of any zone page.
3. **A sending relay** — pick Brevo or Resend and paste that API key. JMail
   verifies the key against the provider before saving and refuses one that
   doesn't authenticate. You only need one to finish; add the second later in
   **Mail server → Sending relays** if you want failover. Connecting Brevo here
   (or re-saving its key there) also registers the webhook that produces the
   Delivered / Opened / Bounced badges.
4. **Complete setup** — the wizard refuses to close until Cloudflare and at least
   one relay are configured, so a half-set-up deployment tells you what it's still
   waiting for.

Then add your **sending addresses** in **Settings → Addresses** — the
`name@yourdomain` identities you'll send from. Catch-all receiving means every
address at your domain is already live for *inbound*; that list is only about what
you can *send as*.

What step 2 does automatically: adds the zone if needed, enables Email Routing,
reads the DNS records Cloudflare requires, and sets the catch-all rule to
**route to Worker → `jmail`**. It does *not* write your SPF/DKIM/DMARC records —
you add those yourself in §8.

### Relays, quotas and failover

**Mail server → Sending relays** is where the outbound pool lives:

- Each relay keeps its own key (`provider_key_brevo`, `provider_key_resend`),
  its own daily counter, and optionally a monthly one.
- The daily default comes from the relay's published free tier — Brevo 300,
  Resend 100. Override it with `PUT /api/providers/:id/quota` if your plan
  changes or you want to leave a margin.
- `PUT /api/providers/order` sets the failover order. A send goes to the first
  relay that has room; when one returns a server error or rate limit, the next
  one is tried; when all are spent, the message is **deferred**, not rejected.
- Remove every relay key later and JMail keeps receiving, storing, and queueing —
  only the wizard needs one to close. Queued mail waits, and drains itself the
  moment a relay comes back.

## 7. Point the domain at Cloudflare

If the domain was already on your Cloudflare account, skip this. Otherwise, in
the registrar's panel replace the nameservers with the two Cloudflare gave you
and wait for the zone status to go **Active** (minutes to a few hours).

Email Routing will not switch on until the zone is active.

---

## 8. DNS: receiving and sending

Go to *your domain → Email Routing → DNS records status*. Cloudflare lists the
records it needs; add them all (the wizard can also hand you the exact list).

**Receiving — MX (managed by Cloudflare):**

| Type | Name | Content | Priority |
| --- | --- | --- | --- |
| MX | `@` | `route1.mx.cloudflare.net` | 65 |
| MX | `@` | `route2.mx.cloudflare.net` | 60 |
| MX | `@` | `route3.mx.cloudflare.net` | 52 |

Use the hostnames the dashboard shows; they are per-zone and Cloudflare can add
them for you.

**Sending — SPF, DKIM, DMARC.** These authorise the *relay*, not Cloudflare. Get
the exact values from your relay's own domain-verification page — Brevo:
*Senders → Domains & SMTP → Add domain*, Resend: *Domains → Add* — and add what
they tell you. Typically:

| Type | Name | Content |
| --- | --- | --- |
| TXT | `@` | `v=spf1 include:<relay-spf-host> ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@yourdomain` (start with `p=none`, tighten later) |
| CNAME/TXT | `<selector>._domainkey` | the DKIM value the relay gives you |

Two rules that save hours of debugging:

- **SPF is one record per hostname.** Email Routing also wants an SPF entry on
  `@`. Merge them into a single TXT (`v=spf1 include:a ~all include:b ~all`),
  never two. Two records = both are treated as invalid.
- **DKIM is what actually matters** for deliverability from a relay. SPF alone
  gets you into spam folders on Gmail. Verify the domain in the relay's
  dashboard until it says "verified", then send a test to a Gmail address and
  check *Show original → SPF/DKIM: PASS*.

---

## 9. Attachments: D1 or R2

Out of the box, attachments live in D1 as base64 alongside the message row.
That's fine — it costs nothing and needs no extra setup — but a mailbox with
many attachments spends a lot of D1 storage, and base64 inflates every file by
about a third.

For real attachment work, add an R2 bucket (10 GB free, no egress charges):

```bash
npx wrangler r2 bucket create jmail-attachments
```

Uncomment the `[[r2_buckets]]` block in `wrangler.toml` (binding must be
`ATTACHMENTS`, bucket name must match) and redeploy. Per-file cap goes from 5 MB
to 25 MB. Existing D1-stored attachments keep working; new ones go to R2.

Received mail is bounded as it is stored, so one oversized spam run cannot fill
the 5 GB D1 budget: 1 MB of text, 2 MB of HTML, a 998-character subject, 256 KB
of headers and 25 attached files per message. Anything over the limit is kept
and marked as truncated inside the message, never silently dropped.

## 10. Cron: the queue, scheduled sends, and webhook delivery

`[triggers] crons = ["*/5 * * * *"]` is already in `wrangler.toml`. That tick:

1. drains due rows from the send queue (20 per tick) — this is what delivers
   scheduled mail and retries anything a relay outage or exhausted quota
   deferred;
2. delivers due outbound webhooks (25 per tick, 8-step backoff);
3. expires queue rows older than `queue_retention_days` (default 14) and prunes
   webhook delivery logs after 7 days;
4. cleans expired sessions.

Each row is claimed before it is worked on, with a lease of ten minutes. Two
ticks that overlap — or the cron firing while a `/api/v1/send` request is still
waiting on a relay — therefore cannot post the same message twice. A tick that
is killed mid-send costs only the lease: the row becomes due again and retries.

Keep it at every 5 minutes unless you want faster webhook fan-out; `*/2 * * * *`
is still 720 calls a day against a 100,000-request budget.

## 11. Give your other projects access

This is the part that replaces "install a mail server on the box".

In the web app: **Mail server → Project tokens → New token.** Give it a name, the scopes
it needs (`send`, `read`, `status`), a per-minute rate limit, a daily budget, and
optionally pin the `from` addresses it may use. Copy the secret **once** — it's
stored as a SHA-256 hash and cannot be shown again.

Then from any project:

```bash
curl -X POST https://jmail.<account>.workers.dev/api/v1/send \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"from":"alerts@yourdomain","to":["you@yourdomain"],"subject":"Deploy done","text":"prod is up"}'
```

Full reference: [`API.md`](./API.md). Ready-made snippets for Node, Python, PHP
and cron, plus the SMTP-only story, are in [`INTEGRATIONS.md`](./INTEGRATIONS.md).

## 12. Optional: your own hostname instead of workers.dev

To serve the app from `mail.yourdomain.com` — which also keeps your cookie and
CORS origins tidy — add a Custom Domain for the Worker in the Cloudflare
dashboard (*Workers & Pages → jmail → Settings → Domains & Routes*). It creates
the CNAME itself and the route runs on the free tier.

Leave `/api/v1/*` reachable from whatever origin your projects expect; the API
rejects cross-origin **mutations** unless the Origin matches the request origin.

---

## 13. Verify it works

Run through these five checks; each one exercises a different subsystem.

```bash
# 1. Worker alive + clock skew helper
curl -s https://jmail.<account>.workers.dev/api/health

# 2. Inbound: send mail from any external address to anything@yourdomain,
#    then look in the inbox. If it's missing, check the routing rule points at
#    the Worker and the MX records are live:
npx wrangler d1 execute jmail-db --remote --command \
  "SELECT id, type, from_address, to_address, created_at FROM emails ORDER BY created_at DESC LIMIT 5"

# 3. Outbound through a relay
curl -s -X POST https://jmail.<account>.workers.dev/api/v1/send \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"from":"alerts@yourdomain","to":["you@yourdomain"],"subject":"JMail test","text":"ok"}'

# 4. Which relay has room left today
curl -s https://jmail.<account>.workers.dev/api/v1/quota \
  -H "Authorization: Bearer <token>"

# 5. Queue actually draining? Watch a tick.
npx wrangler tail 2>/dev/null | grep cron
```

Then send yourself a test to a Gmail address and confirm **DKIM=PASS**. That is
the single biggest determinant of whether your mail lands in the inbox.

## 14. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing arrives in the inbox | MX not propagated, catch-all off, or rule points at a stale Worker name | *Email Routing → Rules*: catch-all must be **Route to Worker** and the Worker must be `jmail`. Routing changes can take ~15 min to take effect. |
| Catch-all delivers but addresses 404 | Rule was created as "Forward to email" instead of Worker | Re-run the wizard, or `curl -X POST -H "Authorization: Bearer <session token>" -d '{"workerName":"jmail"}' <origin>/api/setup/cloudflare/worker-routing` |
| Send returns `status: queued` and never becomes `sent` | No relay configured, or every relay is out of daily quota | `GET /api/v1/quota`. Free relays reset at 00:00 UTC; the row retries itself on the ladder — nothing is lost. |
| Relay returns 401/403 on every send | Key rotated or domain not verified there | Re-enter the key in Settings; verify the sending domain in the relay's dashboard. |
| Mail lands in Gmail spam | DKIM missing or SPF split across two TXT records | Merge SPF into one record; confirm the DKIM CNAME; keep the From domain equal to the verified signing domain. |
| Mailbox feels slow and D1 storage climbs | Every attachment is a base64 row in D1 | Enable R2 (§9). |
| Setup wizard won't accept the password | `SETUP_CODE` mismatch, or setup already completed | Check `wrangler secret list`; `SELECT value FROM settings WHERE key='setup_completed'` should be absent or `false`. |
| Login blocked with "Too many attempts" | 5-per-15-minutes limiter (password and passkey share the budget) | Wait out the window shown in `retryAfter`, or check `SELECT * FROM rate_limits`. |
| Inbound attachments missing | Cloudflare Email Routing caps a message near 5 MiB | Nothing to fix — this is a platform limit; forward big files by link. |

## 15. Backup and housekeeping

Your whole mailbox is one SQLite file:

```bash
npx wrangler d1 execute jmail-db --remote --command \
  "SELECT * FROM emails" > backup-emails.csv
# or a full export:
npx wrangler d1 export jmail-db --remote --output=backup-$(date +%F).sql
```

Put that in a weekly cron. Also worth knowing:

- **GDPR-ish hygiene**: Settings → `queue_retention_days`, and the mailbox export
  screen produces a portable `.mbox`.
- **Upgrading**: `git pull && pnpm install && pnpm build && pnpm --filter
  @jmail/worker deploy`. On a fresh database `schema.sql` already contains every
  table and the current column names, so nothing else is needed; on a database you
  deployed earlier, apply only the `src/db/migrations/` files you're missing —
  README's [Upgrading](../README.md#upgrading) section lists them in order with the
  probe that tells you which generation you're on.
- **Resetting admin access** (lost password): the hash and the wizard flag live in
  D1 — `DELETE FROM settings WHERE key='admin_password_hash'` and
  `DELETE FROM settings WHERE key='setup_completed'`, then reload the app and
  re-run setup with your `SETUP_CODE`. API tokens are unaffected, and any session
  you already issued stays valid until it expires — to kick everyone out, also
  `DELETE FROM sessions`.
