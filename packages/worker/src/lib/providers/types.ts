/**
 * Outbound relay abstraction.
 *
 * JMail never speaks SMTP itself — Cloudflare Workers cannot open TCP
 * sockets, and every free option requires an HTTPS relay. Providers are
 * pooled so a single relay's daily cap does not become the system's cap.
 */

export type ProviderId = 'brevo' | 'resend';

export interface Recipient {
  name?: string;
  email: string;
}

export interface ProviderAttachment {
  filename: string;
  /** Base64, no line breaks */
  content: string;
  contentType?: string;
}

export interface OutboundMessage {
  from: Recipient;
  to: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: Recipient;
  headers?: Record<string, string>;
  attachments?: ProviderAttachment[];
  /** RFC Message-ID we generated ourselves, so threading survives the relay */
  messageId?: string;
  tags?: Record<string, string>;
}

export interface ProviderSendResult {
  /** Identifier the relay returns, used to correlate delivery webhooks */
  providerMessageId: string;
}

export interface MailProvider {
  id: ProviderId;
  label: string;
  /** Limits published by the relay, so mail it would reject is never offered to it. */
  limits: {
    /** null when the relay publishes no per-day cap */
    freeDaily: number | null;
    maxRecipients: number;
    maxMessageBytes: number;
  };
  /** Send through the relay. Throws the error classes below on failure. */
  send(apiKey: string, message: OutboundMessage): Promise<ProviderSendResult>;
  /** Verify credentials and domain sender identity, for the setup UI */
  verify(apiKey: string): Promise<void>;
}

/** The message itself is unacceptable (bad address, unverified domain, blocked attachment). */
export class PermanentSendError extends Error {
  constructor(message: string, readonly provider: ProviderId) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

/** Relay is temporarily unavailable or rate-limited; another provider may succeed. */
export class TransientSendError extends Error {
  constructor(message: string, readonly provider: ProviderId) {
    super(message);
    this.name = 'TransientSendError';
  }
}

/** Every configured provider is out of quota; the message stays queued. */
export class QuotaExhaustedError extends Error {
  constructor(message = 'All send providers are out of quota') {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}
