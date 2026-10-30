import { relayGet, relayPost } from './http';
import { TransientSendError, type MailProvider, type OutboundMessage, type ProviderSendResult, type Recipient } from './types';

const BASE = 'https://api.resend.com';

function format(recipient: Recipient): string {
  return recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email;
}

/**
 * Request shape verified against Resend's API reference:
 * POST /emails with `Authorization: Bearer re_…`, reply_to, headers,
 * attachments as [{ filename, content (base64), content_type }], response `{ id }`.
 */
export const resendProvider: MailProvider = {
  id: 'resend',
  label: 'Resend',
  limits: { freeDaily: 100, maxRecipients: 50, maxMessageBytes: 24 * 1024 * 1024 },

  async send(apiKey: string, message: OutboundMessage): Promise<ProviderSendResult> {
    if (!message.to.length) throw new Error('At least one recipient is required');

    const payload: Record<string, unknown> = {
      from: format(message.from),
      to: message.to.map(format),
      subject: message.subject,
    };
    if (message.cc?.length) payload.cc = message.cc.map(format);
    if (message.bcc?.length) payload.bcc = message.bcc.map(format);
    if (message.text !== undefined) payload.text = message.text;
    if (message.html !== undefined) payload.html = message.html;
    if (message.replyTo) payload.reply_to = format(message.replyTo);
    if (message.headers && Object.keys(message.headers).length > 0) payload.headers = message.headers;
    if (message.attachments?.length) {
      payload.attachments = message.attachments.map(att => ({
        filename: att.filename,
        content: att.content,
        ...(att.contentType ? { content_type: att.contentType } : {}),
      }));
    }

    const response = await relayPost('resend', `${BASE}/emails`, { Authorization: `Bearer ${apiKey}` }, payload);
    const body = response.body as { id?: string } | null;
    if (!body?.id) {
      throw new TransientSendError('Resend accepted the send but returned no id', 'resend');
    }
    return { providerMessageId: body.id };
  },

  async verify(apiKey: string): Promise<void> {
    await relayGet('resend', `${BASE}/domains`, { Authorization: `Bearer ${apiKey}` });
  },
};
