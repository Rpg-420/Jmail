-- Drop the setting rows the first mail-server migration seeded but that no code
-- reads: quotas for relays that were never wired up, an override that duplicated
-- the registry's own free-tier number, and a rate limit key with no reader.
-- Fresh installs get the shortened seed from schema.sql. Apply once.

DELETE FROM settings WHERE key IN (
    'provider_quota_mailjet_day',
    'provider_quota_smtp2go_month',
    'provider_quota_brevo_day',
    'provider_quota_resend_day',
    'api_rate_limit_per_min'
);

UPDATE settings
   SET value = '["brevo","resend"]'
 WHERE key = 'provider_order'
   AND value = '["brevo","resend","mailjet","smtp2go"]';
