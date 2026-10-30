-- Rename the relay message id column left over from the original Mailgun-only backend.
-- The stored value is whatever id the active relay returned (Brevo or Resend), so the
-- column is now named after what it holds. Apply once; fresh installs get the new name
-- from schema.sql.

DROP INDEX IF EXISTS idx_emails_mailgun;
ALTER TABLE emails RENAME COLUMN mailgun_id TO provider_message_id;
CREATE INDEX IF NOT EXISTS idx_emails_provider_message ON emails(provider_message_id);
