export type EmailType = 'received' | 'sent' | 'draft' | 'scheduled';

export interface Email {
  id: string;
  type: EmailType;
  from_address: string;
  to_address: string;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  headers: string | null;
  raw_size: number | null;
  is_read: number;
  is_starred: number;
  archived: number;
  labels: string; // JSON array of strings
  message_id: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  delivery_status: string | null;
  scheduled_at: string | null;
  provider_message_id: string | null;
  token_id: string | null;
  idempotency_key: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  provider: string | null;
  created_at: string;
  /** Populated by list/search queries via subselect */
  attachment_count?: number;
}

export interface Setting {
  key: string;
  value: string;
  updated_at: string;
}

export interface Address {
  id: string;
  address: string;
  display_name: string | null;
  is_default: number;
  created_at: string;
}

export interface Session {
  id: string;
  token: string;
  expires_at: string;
  created_at: string;
}

export interface Attachment {
  id: string;
  email_id: string;
  filename: string;
  content_type: string;
  size: number;
  content: string | null; // Base64 encoded (null when stored in R2)
  r2_key: string | null;  // R2 object key (null when stored inline)
  created_at: string;
}

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  notes: string | null;
  last_contacted_at: string | null;
  created_at: string;
}

export interface Credential {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Fields accepted by createEmail; only identity and envelope are required. */
export interface NewEmailInput {
  id: string;
  type: EmailType;
  from_address: string;
  to_address: string;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  headers?: string | null;
  raw_size?: number | null;
  is_read?: number;
  is_starred?: number;
  archived?: number;
  labels?: string;
  message_id?: string | null;
  in_reply_to?: string | null;
  thread_id?: string | null;
  delivery_status?: string | null;
  scheduled_at?: string | null;
  provider_message_id?: string | null;
  token_id?: string | null;
  idempotency_key?: string | null;
  attempts?: number;
  next_attempt_at?: string | null;
  last_error?: string | null;
  provider?: string | null;
}

export interface ApiToken {
  id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  /** JSON array of scope names */
  scopes: string;
  identity_address: string | null;
  rate_per_min: number;
  daily_budget: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  /** JSON array of event names */
  events: string;
  token_id: string | null;
  active: number;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  payload: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export class DatabaseQueries {
  constructor(private db: D1Database) {}

  // ==================== Settings ====================

  async getSetting(key: string): Promise<string | null> {
    const result = await this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return result?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(key, value)
      .run();
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const results = await this.db
      .prepare('SELECT key, value FROM settings')
      .all<Setting>();

    const settings: Record<string, string> = {};
    for (const row of results.results || []) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  // ==================== Emails ====================

  async createEmail(email: NewEmailInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO emails (id, type, from_address, to_address, cc, bcc, subject, body_text, body_html, headers, raw_size, is_read, is_starred, archived, labels, message_id, in_reply_to, thread_id, delivery_status, scheduled_at, provider_message_id, token_id, idempotency_key, attempts, next_attempt_at, last_error, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        email.id,
        email.type,
        email.from_address,
        email.to_address,
        email.cc ?? null,
        email.bcc ?? null,
        email.subject ?? null,
        email.body_text ?? null,
        email.body_html ?? null,
        email.headers ?? null,
        email.raw_size ?? null,
        email.is_read ?? 0,
        email.is_starred ?? 0,
        email.archived ?? 0,
        email.labels ?? '[]',
        email.message_id ?? null,
        email.in_reply_to ?? null,
        email.thread_id ?? null,
        email.delivery_status ?? null,
        email.scheduled_at ?? null,
        email.provider_message_id ?? null,
        email.token_id ?? null,
        email.idempotency_key ?? null,
        email.attempts ?? 0,
        email.next_attempt_at ?? null,
        email.last_error ?? null,
        email.provider ?? null
      )
      .run();
  }

  /** Update draft/scheduled email fields in place */
  async updateEmailContent(id: string, fields: {
    from_address: string;
    to_address: string;
    cc: string | null;
    bcc: string | null;
    subject: string | null;
    body_text: string | null;
    body_html: string | null;
    scheduled_at?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE emails SET from_address = ?, to_address = ?, cc = ?, bcc = ?, subject = ?, body_text = ?, body_html = ?, scheduled_at = ? WHERE id = ?`
      )
      .bind(
        fields.from_address,
        fields.to_address,
        fields.cc,
        fields.bcc,
        fields.subject,
        fields.body_text,
        fields.body_html,
        fields.scheduled_at ?? null,
        id
      )
      .run();
  }

  async getEmail(id: string): Promise<Email | null> {
    return this.db
      .prepare('SELECT * FROM emails WHERE id = ?')
      .bind(id)
      .first<Email>();
  }

  async listEmails(
    type?: EmailType,
    options?: {
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
      starredOnly?: boolean;
      archivedOnly?: boolean;
      folder?: string;
      label?: string;
    }
  ): Promise<Email[]> {
    let query = 'SELECT emails.*, (SELECT COUNT(*) FROM attachments WHERE attachments.email_id = emails.id) AS attachment_count FROM emails';
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    if (options?.unreadOnly) {
      conditions.push('is_read = 0');
    }

    if (options?.starredOnly) {
      conditions.push('is_starred = 1');
    }

    // Archived mail lives in its own view; everything else excludes it
    if (options?.archivedOnly) {
      conditions.push('archived = 1');
    } else {
      conditions.push('archived = 0');
    }

    if (options?.folder) {
      conditions.push('EXISTS (SELECT 1 FROM email_folders WHERE email_id = emails.id AND folder_id = ?)');
      params.push(options.folder);
    } else if (!options?.archivedOnly && !options?.label) {
      conditions.push('NOT EXISTS (SELECT 1 FROM email_folders WHERE email_id = emails.id)');
    }

    if (options?.label) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(emails.labels) WHERE json_each.value = ?)");
      params.push(options.label);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.prepare(query);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const results = await bound.all<Email>();
    return results.results || [];
  }

  /** Messages submitted by one API token, newest first, with status filtering. */
  async listEmailsByToken(
    tokenId: string,
    options: { limit?: number; offset?: number; status?: string; idempotencyKey?: string } = {}
  ): Promise<Email[]> {
    const conditions = ['token_id = ?'];
    const params: (string | number)[] = [tokenId];

    if (options.status === 'pending') {
      conditions.push("(delivery_status IS NULL OR delivery_status IN ('queued', 'deferred'))");
    } else if (options.status) {
      conditions.push('delivery_status = ?');
      params.push(options.status);
    }

    if (options.idempotencyKey) {
      conditions.push('idempotency_key = ?');
      params.push(options.idempotencyKey);
    }

    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;

    const results = await this.db
      .prepare(
        `SELECT * FROM emails WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<Email>();
    return results.results || [];
  }

  /**
   * Full-text search across subject, body, and addresses (FTS5).   * The query is normalized into quoted terms so FTS syntax can't error.
   */
  async searchEmails(query: string, limit = 50): Promise<Email[]> {
    const terms = query
      .split(/\s+/)
      .map(t => t.replace(/["*^]/g, ''))
      .filter(Boolean)
      .map(t => `"${t}"*`)
      .join(' ');

    if (!terms) return [];

    const results = await this.db
      .prepare(
        `SELECT e.*, (SELECT COUNT(*) FROM attachments WHERE attachments.email_id = e.id) AS attachment_count
         FROM emails e
         JOIN emails_fts f ON e.rowid = f.rowid
         WHERE emails_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .bind(terms, limit)
      .all<Email>();
    return results.results || [];
  }

  async getEmailsByThread(threadId: string): Promise<Email[]> {
    const results = await this.db
      .prepare("SELECT * FROM emails WHERE thread_id = ? ORDER BY created_at")
      .bind(threadId)
      .all<Email>();
    return results.results || [];
  }

  async getEmailByMessageId(messageId: string): Promise<Email | null> {
    return this.db
      .prepare('SELECT * FROM emails WHERE message_id = ? LIMIT 1')
      .bind(messageId)
      .first<Email>();
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.db
      .prepare('UPDATE emails SET archived = ? WHERE id = ?')
      .bind(archived ? 1 : 0, id)
      .run();
  }

  async setLabels(id: string, labels: string[]): Promise<void> {
    await this.db
      .prepare('UPDATE emails SET labels = ? WHERE id = ?')
      .bind(JSON.stringify(labels), id)
      .run();
  }

  async listAllLabels(): Promise<string[]> {
    const results = await this.db
      .prepare("SELECT DISTINCT json_each.value AS label FROM emails, json_each(emails.labels) ORDER BY label")
      .all<{ label: string }>();
    return (results.results || []).map(r => r.label);
  }

  async getEmailByProviderMessageId(providerMessageId: string): Promise<Email | null> {
    return this.db
      .prepare("SELECT * FROM emails WHERE provider_message_id = ? AND type = 'sent' LIMIT 1")
      .bind(providerMessageId)
      .first<Email>();
  }

  async updateDeliveryStatus(providerMessageId: string, status: string): Promise<void> {
    await this.db
      .prepare("UPDATE emails SET delivery_status = ? WHERE provider_message_id = ? AND type = 'sent'")
      .bind(status, providerMessageId)
      .run();
  }

  /**
   * Convert a pending/draft/scheduled row into a sent email after delivery.
   * The relay's message id becomes the RFC Message-ID so future replies thread.
   */
  async markEmailSent(id: string, providerMessageId: string | null, provider: string | null = null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE emails SET
           type = 'sent',
           delivery_status = 'queued',
           provider_message_id = ?,
           provider = COALESCE(?, provider),
           message_id = COALESCE(?, message_id),
           thread_id = COALESCE(thread_id, ?, id),
           scheduled_at = NULL,
           next_attempt_at = NULL,
           last_error = NULL,
           created_at = datetime('now')
         WHERE id = ?`
      )
      .bind(providerMessageId, provider, providerMessageId, providerMessageId, id)
      .run();
  }

  /** Move a draft into the scheduled queue (clears any failed marker) */
  async setScheduled(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE emails SET type = 'scheduled', delivery_status = NULL WHERE id = ?")
      .bind(id)
      .run();
  }

  /** Demote a failed send back to an editable draft */
  async markSendFailed(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE emails SET type = 'draft', delivery_status = 'failed', scheduled_at = NULL WHERE id = ?")
      .bind(id)
      .run();
  }

  /** Every email, newest first (mbox export) */
  async listAllEmails(limit = 5000): Promise<Email[]> {
    const results = await this.db
      .prepare('SELECT * FROM emails ORDER BY created_at LIMIT ?')
      .bind(limit)
      .all<Email>();
    return results.results || [];
  }

  async markScheduledFailed(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE emails SET delivery_status = 'failed' WHERE id = ?")
      .bind(id)
      .run();
  }

  /** Scheduled emails that are due and have not permanently failed */
  async listDueScheduledEmails(): Promise<Email[]> {
    const results = await this.db
      .prepare(
        "SELECT * FROM emails WHERE type = 'scheduled' AND scheduled_at <= datetime('now') AND (delivery_status IS NULL OR delivery_status != 'failed')"
      )
      .all<Email>();
    return results.results || [];
  }

  async markAsRead(id: string): Promise<void> {
    await this.db
      .prepare('UPDATE emails SET is_read = 1 WHERE id = ?')
      .bind(id)
      .run();
  }

  async markAsUnread(id: string): Promise<void> {
    await this.db
      .prepare('UPDATE emails SET is_read = 0 WHERE id = ?')
      .bind(id)
      .run();
  }

  async toggleStar(id: string): Promise<void> {
    await this.db
      .prepare('UPDATE emails SET is_starred = NOT is_starred WHERE id = ?')
      .bind(id)
      .run();
  }

  async deleteEmail(id: string): Promise<void> {
    // D1 does not guarantee foreign_keys pragma, so delete attachments explicitly
    await this.db.batch([
      this.db.prepare('DELETE FROM attachments WHERE email_id = ?').bind(id),
      this.db.prepare('DELETE FROM emails WHERE id = ?').bind(id),
    ]);
  }

  async getEmailActivity(days: number): Promise<Array<{ day: string; type: string; count: number }>> {
    const results = await this.db
      .prepare(
        `SELECT date(created_at) AS day, type, COUNT(*) AS count
         FROM emails
         WHERE created_at >= datetime('now', ?)
         GROUP BY day, type`
      )
      .bind(`-${days - 1} days`)
      .all<{ day: string; type: string; count: number }>();
    return results.results || [];
  }

  async getStorageBytes(): Promise<number> {
    const result = await this.db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(raw_size), 0) FROM emails) +
           (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE type = 'sent'))
         AS bytes`
      )
      .first<{ bytes: number }>();
    return result?.bytes ?? 0;
  }

  async getEmailStats(): Promise<{
    total_received: number;
    total_sent: number;
    unread: number;
    starred: number;
  }> {
    const results = await this.db.batch([
      this.db.prepare("SELECT COUNT(*) as count FROM emails WHERE type = 'received' AND archived = 0"),
      this.db.prepare("SELECT COUNT(*) as count FROM emails WHERE type = 'sent'"),
      this.db.prepare("SELECT COUNT(*) as count FROM emails WHERE is_read = 0 AND type = 'received' AND archived = 0"),
      this.db.prepare('SELECT COUNT(*) as count FROM emails WHERE is_starred = 1'),
    ]);

    return {
      total_received: (results[0].results?.[0] as { count: number })?.count ?? 0,
      total_sent: (results[1].results?.[0] as { count: number })?.count ?? 0,
      unread: (results[2].results?.[0] as { count: number })?.count ?? 0,
      starred: (results[3].results?.[0] as { count: number })?.count ?? 0,
    };
  }

  // ==================== Addresses ====================

  async createAddress(address: Omit<Address, 'created_at'>): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO addresses (id, address, display_name, is_default) VALUES (?, ?, ?, ?)'
      )
      .bind(address.id, address.address, address.display_name, address.is_default)
      .run();
  }

  async listAddresses(): Promise<Address[]> {
    const results = await this.db
      .prepare('SELECT * FROM addresses ORDER BY created_at')
      .all<Address>();
    return results.results || [];
  }

  async deleteAddress(id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM addresses WHERE id = ?')
      .bind(id)
      .run();
  }

  async setDefaultAddress(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('UPDATE addresses SET is_default = 0'),
      this.db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ?').bind(id),
    ]);
  }

  // ==================== Sessions ====================

  async createSession(session: Omit<Session, 'created_at'>): Promise<void> {
    await this.db
      .prepare('INSERT INTO sessions (id, token, expires_at) VALUES (?, ?, ?)')
      .bind(session.id, session.token, session.expires_at)
      .run();
  }

  async getSessionByToken(token: string): Promise<Session | null> {
    return this.db
      .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')")
      .bind(token)
      .first<Session>();
  }

  async deleteSession(token: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM sessions WHERE token = ?')
      .bind(token)
      .run();
  }

  async cleanExpiredSessions(): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE expires_at < datetime('now')")
      .run();
  }

  /** Used after a password change: an old session must not outlive the secret. */
  async deleteAllSessions(): Promise<void> {
    await this.db.prepare('DELETE FROM sessions').run();
  }

  // ==================== Attachments ====================

  async createAttachment(attachment: Omit<Attachment, 'created_at'>): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO attachments (id, email_id, filename, content_type, size, content, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        attachment.id,
        attachment.email_id,
        attachment.filename,
        attachment.content_type,
        attachment.size,
        attachment.content,
        attachment.r2_key
      )
      .run();
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    return this.db
      .prepare('SELECT * FROM attachments WHERE id = ?')
      .bind(id)
      .first<Attachment>();
  }

  async getAttachmentsByEmailId(emailId: string): Promise<Omit<Attachment, 'content'>[]> {
    const results = await this.db
      .prepare('SELECT id, email_id, filename, content_type, size, r2_key, created_at FROM attachments WHERE email_id = ?')
      .bind(emailId)
      .all<Omit<Attachment, 'content'>>();
    return results.results || [];
  }

  async deleteAttachmentsByEmailId(emailId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM attachments WHERE email_id = ?')
      .bind(emailId)
      .run();
  }

  // ==================== Contacts ====================

  async listContacts(): Promise<Contact[]> {
    const results = await this.db
      .prepare('SELECT * FROM contacts ORDER BY COALESCE(name, email) COLLATE NOCASE')
      .all<Contact>();
    return results.results || [];
  }

  /** Create or refresh a contact; an existing name is never clobbered by null */
  async upsertContact(contact: { id: string; email: string; name?: string | null; notes?: string | null }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO contacts (id, email, name, notes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           notes = COALESCE(excluded.notes, contacts.notes)`
      )
      .bind(contact.id, contact.email.toLowerCase(), contact.name ?? null, contact.notes ?? null)
      .run();
  }

  async updateContact(id: string, fields: { email: string; name: string | null; notes: string | null }): Promise<void> {
    await this.db
      .prepare('UPDATE contacts SET email = ?, name = ?, notes = ? WHERE id = ?')
      .bind(fields.email.toLowerCase(), fields.name, fields.notes, id)
      .run();
  }

  async deleteContact(id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM contacts WHERE id = ?')
      .bind(id)
      .run();
  }

  async touchContactLastContacted(email: string): Promise<void> {
    await this.db
      .prepare("UPDATE contacts SET last_contacted_at = datetime('now') WHERE email = ?")
      .bind(email.toLowerCase())
      .run();
  }

  // ==================== Push Subscriptions ====================

  async createPushSubscription(sub: Omit<PushSubscription, 'created_at'>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
      )
      .bind(sub.id, sub.endpoint, sub.p256dh, sub.auth)
      .run();
  }

  async listPushSubscriptions(): Promise<PushSubscription[]> {
    const results = await this.db
      .prepare('SELECT * FROM push_subscriptions')
      .all<PushSubscription>();
    return results.results || [];
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
      .bind(endpoint)
      .run();
  }

  // ==================== WebAuthn Credentials ====================

  async createCredential(credential: Omit<Credential, 'created_at' | 'last_used_at'>): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO credentials (id, credential_id, public_key, counter, transports, device_name) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(
        credential.id,
        credential.credential_id,
        credential.public_key,
        credential.counter,
        credential.transports,
        credential.device_name
      )
      .run();
  }

  async listCredentials(): Promise<Credential[]> {
    const results = await this.db
      .prepare('SELECT * FROM credentials ORDER BY created_at')
      .all<Credential>();
    return results.results || [];
  }

  async getCredentialByCredentialId(credentialId: string): Promise<Credential | null> {
    return this.db
      .prepare('SELECT * FROM credentials WHERE credential_id = ?')
      .bind(credentialId)
      .first<Credential>();
  }

  async updateCredentialCounter(credentialId: string, counter: number): Promise<void> {
    await this.db
      .prepare("UPDATE credentials SET counter = ?, last_used_at = datetime('now') WHERE credential_id = ?")
      .bind(counter, credentialId)
      .run();
  }

  async deleteCredential(id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM credentials WHERE id = ?')
      .bind(id)
      .run();
  }

  async countCredentials(): Promise<number> {
    const result = await this.db
      .prepare('SELECT COUNT(*) as count FROM credentials')
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  // ==================== WebAuthn Challenges ====================

  async createChallenge(challenge: {
    id: string;
    type: 'registration' | 'authentication';
    challenge: string;
    expires_at: string;
  }): Promise<void> {
    await this.db.batch([
      // Opportunistic cleanup of expired challenges
      this.db.prepare("DELETE FROM challenges WHERE expires_at < datetime('now')"),
      this.db
        .prepare('INSERT INTO challenges (id, type, challenge, expires_at) VALUES (?, ?, ?, ?)')
        .bind(challenge.id, challenge.type, challenge.challenge, challenge.expires_at),
    ]);
  }

  /**
   * Atomically look up and delete a challenge so it can only be used once.
   * Returns true if the challenge existed and was still valid.
   */
  async consumeChallenge(type: 'registration' | 'authentication', challenge: string): Promise<boolean> {
    // One statement, so two concurrent verifications of the same challenge
    // cannot both see it alive and both pass.
    const consumed = await this.db
      .prepare("DELETE FROM challenges WHERE type = ? AND challenge = ? AND expires_at > datetime('now') RETURNING id")
      .bind(type, challenge)
      .first<{ id: string }>();

    return !!consumed;
  }

  // ==================== API tokens (mail-server surface) ====================

  async createApiToken(token: {
    id: string;
    token_hash: string;
    token_prefix: string;
    name: string;
    scopes: string[];
    identity_address: string | null;
    rate_per_min: number;
    daily_budget: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_tokens (id, token_hash, token_prefix, name, scopes, identity_address, rate_per_min, daily_budget)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        token.id,
        token.token_hash,
        token.token_prefix,
        token.name,
        JSON.stringify(token.scopes),
        token.identity_address,
        token.rate_per_min,
        token.daily_budget
      )
      .run();
  }

  async listApiTokens(day: string): Promise<Array<ApiToken & { sent_today: number; failed_today: number }>> {
    const results = await this.db
      .prepare(
        `SELECT t.*, COALESCE(u.sent, 0) AS sent_today, COALESCE(u.failed, 0) AS failed_today
         FROM api_tokens t
         LEFT JOIN token_usage u ON u.token_id = t.id AND u.day = ?
         ORDER BY t.created_at DESC`
      )
      .bind(day)
      .all<ApiToken & { sent_today: number; failed_today: number }>();
    return results.results || [];
  }

  async getApiTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    return this.db
      .prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .bind(tokenHash)
      .first<ApiToken>();
  }

  async getApiToken(id: string): Promise<ApiToken | null> {
    return this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').bind(id).first<ApiToken>();
  }

  async updateApiToken(id: string, fields: { name: string; scopes: string[]; identity_address: string | null; rate_per_min: number; daily_budget: number }): Promise<void> {
    await this.db
      .prepare('UPDATE api_tokens SET name = ?, scopes = ?, identity_address = ?, rate_per_min = ?, daily_budget = ? WHERE id = ?')
      .bind(fields.name, JSON.stringify(fields.scopes), fields.identity_address, fields.rate_per_min, fields.daily_budget, id)
      .run();
  }

  async revokeApiToken(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  async touchApiToken(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  async recordTokenUsage(tokenId: string, day: string, kind: 'sent' | 'failed'): Promise<void> {
    const column = kind === 'sent' ? 'sent' : 'failed';
    await this.db
      .prepare(
        `INSERT INTO token_usage (token_id, day, sent, failed, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(token_id, day) DO UPDATE SET ${column} = ${column} + 1, updated_at = datetime('now')`
      )
      .bind(tokenId, day, kind === 'sent' ? 1 : 0, kind === 'failed' ? 1 : 0)
      .run();
  }

  async getTokenUsage(tokenId: string, day: string): Promise<{ sent: number; failed: number }> {
    const row = await this.db
      .prepare('SELECT sent, failed FROM token_usage WHERE token_id = ? AND day = ?')
      .bind(tokenId, day)
      .first<{ sent: number; failed: number }>();
    return { sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
  }

  async listTokenUsageHistory(tokenId: string, days: number): Promise<Array<{ day: string; sent: number; failed: number }>> {
    const results = await this.db
      .prepare(
        `SELECT day, sent, failed FROM token_usage
         WHERE token_id = ? AND day >= date('now', ?)
         ORDER BY day DESC`
      )
      .bind(tokenId, `-${days} days`)
      .all<{ day: string; sent: number; failed: number }>();
    return results.results || [];
  }

  // ==================== Provider quota ledger ====================

  async getProviderUsage(provider: string, kind: 'day' | 'month', period: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT used FROM provider_usage WHERE provider = ? AND kind = ? AND period = ?')
      .bind(provider, kind, period)
      .first<{ used: number }>();
    return row?.used ?? 0;
  }

  async recordProviderUsage(provider: string, kind: 'day' | 'month', period: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_usage (provider, kind, period, used, updated_at)
         VALUES (?, ?, ?, 1, datetime('now'))
         ON CONFLICT(provider, kind, period) DO UPDATE SET used = used + 1, updated_at = datetime('now')`
      )
      .bind(provider, kind, period)
      .run();
  }

  /** Usage grouped by provider for the last N days, for the settings screen. */
  async listProviderUsage(days: string[]): Promise<Array<{ provider: string; used: number }>> {
    if (days.length === 0) return [];
    const placeholders = days.map(() => '?').join(',');
    const results = await this.db
      .prepare(`SELECT provider, SUM(used) AS used FROM provider_usage WHERE kind = 'day' AND period IN (${placeholders}) GROUP BY provider`)
      .bind(...days)
      .all<{ provider: string; used: number }>();
    return results.results || [];
  }

  /** Per-day, per-provider usage so the settings screen can draw a chart. */
  async listProviderUsageHistory(days: number): Promise<Array<{ provider: string; period: string; used: number }>> {
    const results = await this.db
      .prepare(
        `SELECT provider, period, used FROM provider_usage
         WHERE kind = 'day' AND period >= date('now', ?)
         ORDER BY period DESC, provider`
      )
      .bind(`-${days} days`)
      .all<{ provider: string; period: string; used: number }>();
    return results.results || [];
  }

  /** Queue depth by delivery status — the health number on the dashboard. */
  async queueSummary(): Promise<Array<{ status: string; count: number }>> {
    const results = await this.db
      .prepare(
        `SELECT COALESCE(delivery_status, 'queued') AS status, COUNT(*) AS count
         FROM emails
         WHERE type = 'scheduled'
         GROUP BY COALESCE(delivery_status, 'queued')`
      )
      .all<{ status: string; count: number }>();
    return results.results || [];
  }

  // ==================== Send queue ====================

  /**
   * Rows waiting to be delivered: API-submitted mail and scheduled sends.
   * `next_attempt_at` implements backoff, so a broken relay is retried slowly
   * instead of hammering it every minute.
   */
  async listDueQueueEmails(limit = 20): Promise<Email[]> {
    const results = await this.db
      .prepare(
        `SELECT * FROM emails
         WHERE type = 'scheduled'
           AND scheduled_at <= datetime('now')
           AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered', 'failed'))
           AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
         ORDER BY created_at
         LIMIT ?`
      )
      .bind(limit)
      .all<Email>();
    return results.results || [];
  }

  /**
   * Take exclusive ownership of one due row for `leaseSeconds`, so two
   * overlapping cron drains never hand the same message to a relay twice.
   *
   * The claim repeats the predicate that made the row due, narrowed to one id,
   * with the retry timestamp pushed past the lease: whichever writer lands
   * first moves `next_attempt_at` into the future and the other matches zero
   * rows. A drain that dies mid-send costs nothing but the lease — once it
   * expires the message is due again.
   */
  async claimQueueEmail(id: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE emails
            SET next_attempt_at = datetime('now', '+' || ? || ' seconds')
          WHERE id = ?
            AND type = 'scheduled'
            AND scheduled_at <= datetime('now')
            AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered', 'failed'))
            AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))`
      )
      .bind(leaseSeconds, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async findEmailByIdempotencyKey(tokenId: string, idempotencyKey: string): Promise<Email | null> {
    return this.db
      .prepare('SELECT * FROM emails WHERE token_id = ? AND idempotency_key = ? LIMIT 1')
      .bind(tokenId, idempotencyKey)
      .first<Email>();
  }

  async updateEmailQueueFields(id: string, fields: {
    delivery_status: string;
    attempts: number;
    next_attempt_at: string | null;
    last_error: string | null;
    provider: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE emails SET delivery_status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, provider = ? WHERE id = ?`
      )
      .bind(fields.delivery_status, fields.attempts, fields.next_attempt_at, fields.last_error, fields.provider, id)
      .run();
  }

  /**
   * Put a row back on the queue with a fresh due time. Used when the web UI
   * sends and every relay is at quota — the mail is kept, not discarded.
   */
  async requeueEmail(id: string, nextAttemptAt: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE emails SET
           type = 'scheduled',
           scheduled_at = datetime('now'),
           delivery_status = 'queued',
           next_attempt_at = ?,
           last_error = ?
         WHERE id = ?`
      )
      .bind(nextAttemptAt, error.slice(0, 500), id)
      .run();
  }

  /** Queue rows that were never delivered and are older than the retention window. */
  async listExpiredQueueEmails(retentionDays: number): Promise<Email[]> {
    const results = await this.db
      .prepare(
        `SELECT * FROM emails
         WHERE type = 'scheduled'
           AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered', 'failed'))
           AND created_at < datetime('now', ?)`
      )
      .bind(`-${retentionDays} days`)
      .all<Email>();
    return results.results || [];
  }

  // ==================== Outbound webhooks ====================

  async createWebhookEndpoint(endpoint: {
    id: string;
    url: string;
    secret: string;
    events: string[];
    token_id: string | null;
  }): Promise<void> {
    await this.db
      .prepare('INSERT INTO webhook_endpoints (id, url, secret, events, token_id) VALUES (?, ?, ?, ?, ?)')
      .bind(endpoint.id, endpoint.url, endpoint.secret, JSON.stringify(endpoint.events), endpoint.token_id)
      .run();
  }

  async listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
    const results = await this.db
      .prepare('SELECT * FROM webhook_endpoints ORDER BY created_at')
      .all<WebhookEndpoint>();
    return results.results || [];
  }

  async getWebhookEndpoint(id: string): Promise<WebhookEndpoint | null> {
    return this.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').bind(id).first<WebhookEndpoint>();
  }

  async deleteWebhookEndpoint(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM webhook_deliveries WHERE endpoint_id = ?').bind(id),
      this.db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').bind(id),
    ]);
  }

  async setWebhookSecret(id: string, secret: string): Promise<void> {
    await this.db.prepare('UPDATE webhook_endpoints SET secret = ? WHERE id = ?').bind(secret, id).run();
  }

  async listWebhookDeliveries(endpointId: string, limit = 50): Promise<WebhookDelivery[]> {
    const results = await this.db
      .prepare('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(endpointId, limit)
      .all<WebhookDelivery>();
    return results.results || [];
  }

  async getWebhookDelivery(id: string): Promise<WebhookDelivery | null> {
    return this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').bind(id).first<WebhookDelivery>();
  }

  /** Endpoints subscribed to an event, optionally narrowed to one token. */
  async listEndpointsForEvent(event: string, tokenId: string | null): Promise<WebhookEndpoint[]> {
    const all = await this.listWebhookEndpoints();
    return all.filter(endpoint => {
      if (!endpoint.active) return false;
      if (endpoint.token_id && tokenId && endpoint.token_id !== tokenId) return false;
      if (endpoint.token_id && !tokenId) return false;
      let events: unknown;
      try {
        events = JSON.parse(endpoint.events);
      } catch {
        return false;
      }
      return Array.isArray(events) && events.includes(event);
    });
  }

  async queueWebhookDelivery(delivery: { id: string; endpoint_id: string; event: string; payload: string }): Promise<void> {
    await this.db
      .prepare('INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, next_attempt_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
      .bind(delivery.id, delivery.endpoint_id, delivery.event, delivery.payload)
      .run();
  }

  async listDueWebhookDeliveries(limit = 25): Promise<WebhookDelivery[]> {
    const results = await this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= datetime('now')
         ORDER BY created_at
         LIMIT ?`
      )
      .bind(limit)
      .all<WebhookDelivery>();
    return results.results || [];
  }

  /**
   * Push one pending delivery past the drain interval so a second tick, or a
   * retried request, cannot post the same event twice while it is in flight.
   * The row stays `pending`, so a tick that dies mid-post retries when the
   * lease expires.
   */
  async claimWebhookDelivery(id: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE webhook_deliveries
            SET next_attempt_at = datetime('now', '+' || ? || ' seconds')
          WHERE id = ?
            AND status = 'pending'
            AND next_attempt_at <= datetime('now')`
      )
      .bind(leaseSeconds, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async markWebhookDelivered(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE webhook_deliveries SET status = 'delivered', delivered_at = datetime('now'), last_error = NULL WHERE id = ?")
      .bind(id)
      .run();
  }

  async markWebhookAttemptFailed(id: string, attempts: number, nextAttemptAt: string, error: string): Promise<void> {
    await this.db
      .prepare("UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
      .bind(attempts, nextAttemptAt, error.slice(0, 500), id)
      .run();
  }

  async markWebhookFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db
      .prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?")
      .bind(attempts, error.slice(0, 500), id)
      .run();
  }

  /** Dead webhook rows are kept for a week so a project can inspect misses. */
  async pruneWebhookDeliveries(retentionDays = 7): Promise<void> {
    await this.db
      .prepare("DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < datetime('now', ?)")
      .bind(`-${retentionDays} days`)
      .run();
  }

  /** Mail the caller can poll by the id we handed back. */
  async getEmailByTokenAndIdempotency(tokenId: string, idempotencyKey: string): Promise<Email | null> {
    return this.findEmailByIdempotencyKey(tokenId, idempotencyKey);
  }
}

