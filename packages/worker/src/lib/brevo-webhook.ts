import { DatabaseQueries } from '../db/queries';
import { generateToken } from './utils';
import type { BrevoAPI } from '@jmail/brevo-api';

const DELIVERY_EVENTS = [
  'request', 'delivered', 'hardBounce', 'softBounce', 'blocked', 'invalid_email', 'deferred', 'uniqueOpened',
];

/**
 * Register (or reuse) the Brevo transactional webhook that reports delivery
 * status back to this deployment. Never fatal — a missing webhook only costs
 * the Delivered/Opened badges.
 */
export async function ensureBrevoWebhook(
  db: DatabaseQueries,
  brevo: BrevoAPI,
  requestUrl: string
): Promise<void> {
  try {
    let secret = await db.getSetting('brevo_webhook_secret');
    if (!secret) {
      secret = generateToken(24);
      await db.setSetting('brevo_webhook_secret', secret);
    }

    const url = `${new URL(requestUrl).origin}/api/webhooks/brevo/${secret}`;
    const existing = await brevo.webhooks.list();

    if (!existing.some(w => w.url === url)) {
      const created = await brevo.webhooks.create(url, DELIVERY_EVENTS);
      await db.setSetting('brevo_webhook_id', String(created.id));
    }
  } catch (error) {
    console.warn('Brevo webhook registration failed (delivery tracking disabled):', error);
  }
}
