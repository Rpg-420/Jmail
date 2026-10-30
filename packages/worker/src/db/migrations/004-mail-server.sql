-- JMail mail-server layer: API tokens, provider quota ledger, send queue, outbound webhooks.
-- Additive only; safe to run on an existing database.

-- API tokens that other projects authenticate with (secret stored as SHA-256)
CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,          -- first 10 chars, shown in the UI
    name TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '["send"]',  -- JSON array: send | read | status
    identity_address TEXT,               -- when set, From is forced to this address
    rate_per_min INTEGER NOT NULL DEFAULT 60,
    daily_budget INTEGER NOT NULL DEFAULT 500,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_revoked ON api_tokens(revoked_at);

-- Per-provider consumption, so free-tier quotas are enforced locally
-- before a relay ever rejects us. period is 'YYYY-MM-DD' (day) or 'YYYY-MM' (month).
CREATE TABLE IF NOT EXISTS provider_usage (
    provider TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('day', 'month')),
    period TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, kind, period)
);

-- Per-token daily send counts (budget enforcement, separate from provider quota)
CREATE TABLE IF NOT EXISTS token_usage (
    token_id TEXT NOT NULL,
    day TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (token_id, day)
);

-- Outbound webhook endpoints that projects register to receive delivery events
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,                -- HMAC-SHA256 signing key
    events TEXT NOT NULL DEFAULT '["delivered","bounced","failed"]',
    token_id TEXT,                       -- when set, only this token's mail fires it
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Webhook delivery queue with retry/backoff
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,               -- JSON body that gets signed
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

-- Send queue columns on emails: API-submitted mail reuses the existing
-- scheduled/cron delivery path instead of a parallel outbox.
ALTER TABLE emails ADD COLUMN token_id TEXT;
ALTER TABLE emails ADD COLUMN idempotency_key TEXT;
ALTER TABLE emails ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emails ADD COLUMN next_attempt_at TEXT;
ALTER TABLE emails ADD COLUMN last_error TEXT;
ALTER TABLE emails ADD COLUMN provider TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_token ON emails(token_id);
CREATE INDEX IF NOT EXISTS idx_emails_queue ON emails(type, delivery_status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_idempotency
    ON emails(token_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Provider settings rows start disabled until an API key is supplied in Settings.
-- Quotas default to the free-tier limits in the provider registry;
-- provider_quota_<id>_day and provider_quota_<id>_month override them here.
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('provider_order', '["brevo","resend"]'),
    ('max_api_attachment_bytes', '5242880'),
    ('max_api_total_bytes', '10485760'),
    ('queue_retention_days', '14');
