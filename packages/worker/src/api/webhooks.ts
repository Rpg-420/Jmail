import { Hono } from 'hono';
import { DatabaseQueries } from '../db/queries';
import { timingSafeEqual } from '../lib/utils';
import { emitMailEvent, type WebhookEvent } from '../lib/webhooks-out';

export interface Env {
  DB: D1Database;
}

/**
 * Brevo transactional webhook → delivery status on sent emails.
 * The endpoint is unauthenticated but guarded by a random secret in the
 * path, generated when the webhook is registered.
 */

const STATUS_MAP: Record<string, string> = {
  request: 'queued',
  delivered: 'delivered',
  opened: 'opened',
  uniqueOpened: 'opened',
  click: 'opened',
  hardBounce: 'bounced',
  blocked: 'bounced',
  invalid_email: 'bounced',
  softBounce: 'deferred',
  deferred: 'deferred',
  error: 'failed',
};

const STATUS_EVENTS: Record<string, WebhookEvent> = {
  delivered: 'delivered',
  opened: 'opened',
  bounced: 'bounced',
  deferred: 'deferred',
  failed: 'failed',
};

// Later statuses must not be downgraded by out-of-order webhook delivery
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  deferred: 1,
  delivered: 2,
  opened: 3,
  bounced: 4,
  failed: 4,
};

const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post('/brevo/:secret', async (c) => {
  const db = new DatabaseQueries(c.env.DB);

  try {
    const expected = await db.getSetting('brevo_webhook_secret');
    const provided = c.req.param('secret') ?? '';
    if (!expected || !timingSafeEqual(provided, expected)) {
      return c.json({ error: 'Not found' }, 404);
    }

    const payload = await c.req.json<{ event?: string; 'message-id'?: string; email?: string; id?: string }>();
    const event = payload.event;
    const messageId = payload['message-id'];

    if (!event || !messageId || messageId.length > 512) {
      return c.json({ success: true, ignored: true });
    }

    const status = STATUS_MAP[event];
    if (!status) {
      return c.json({ success: true, ignored: true });
    }

    // Only move status forward
    const email = await db.getEmailByProviderMessageId(messageId);
    if (email) {
      const currentRank = STATUS_RANK[email.delivery_status || 'queued'] ?? 0;
      if ((STATUS_RANK[status] ?? 0) >= currentRank) {
        await db.updateDeliveryStatus(messageId, status);

        const outboundEvent = STATUS_EVENTS[status];
        if (outboundEvent) {
          await emitMailEvent(db, outboundEvent, {
            id: email.id,
            to: email.to_address,
            recipient: payload.email ?? null,
            subject: email.subject,
            provider: email.provider,
            provider_message_id: messageId,
            status,
            token_id: email.token_id,
          });
        }
      }
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Brevo webhook error:', error);
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

export default webhooks;
