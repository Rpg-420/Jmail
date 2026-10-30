import { relayGet, relayPost } from './http';
import { TransientSendError, type MailProvider, type OutboundMessage, type ProviderSendResult } from './types';

const BASE = 'https://api.brevo.com/v3';

function nameless(recipient: { name?: string; email: string }) {
  return recipient.name ? { name: recipient.name, email: recipient.email } : { email: recipient.email };
}

/**
 * Request shape verified against the existing, working @jmail/brevo-api client:
 * `attachment` (singular key), textContent/htmlContent, replyTo, headers, tags.
 */
export const brevoProvider: MailProvider = {
  id: 'brevo',
  label: 'Brevo',
  limits: { freeDaily: 300, maxRecipients: 50, maxMessageBytes: 19 * 1024 * 1024 },

  async send(apiKey: string, message: OutboundMessage): Promise<ProviderSendResult> {
    if (!message.to.length) throw new Error('At least one recipient is required');

    const payload: Record<string, unknown> = {
      sender: nameless(message.from),
      to: message.to.map(nameless),
      subject: message.subject,
    };
    if (message.cc?.length) payload.cc = message.cc.map(nameless);
    if (message.bcc?.length) payload.bcc = message.bcc.map(nameless);
    if (message.text) payload.textContent = message.text;
    if (message.html) payload.htmlContent = message.html;
    if (message.replyTo) payload.replyTo = nameless(message.replyTo);
    if (message.headers && Object.keys(message.headers).length > 0) payload.headers = message.headers;
    if (message.attachments?.length) {
      payload.attachment = message.attachments.map(att => ({
        name: att.filename,
        content: att.content,
        contentType: att.contentType,
      }));
    }
    // Brevo tags are flat strings; the token id is what webhooks correlate on.
    if (message.tags && Object.keys(message.tags).length > 0) {
      payload.tags = Object.entries(message.tags).map(([key, value]) => `${key}:${value}`);
    }

    const response = await relayPost('brevo', `${BASE}/smtp/email`, { 'api-key': apiKey }, payload);
    const body = response.body as { messageId?: string; messageIdStr?: string } | null;
    const providerMessageId = body?.messageId || body?.messageIdStr || '';
    if (!providerMessageId) {
      throw new TransientSendError('Brevo accepted the send but returned no message id', 'brevo');
    }
    return { providerMessageId };
  },

  async verify(apiKey: string): Promise<void> {
    await relayGet('brevo', `${BASE}/senders`, { 'api-key': apiKey });
  },
};
