import { Hono } from 'hono';
import { DatabaseQueries, type WebhookEndpoint } from '../db/queries';
import { generateId, generateToken } from '../lib/utils';
import {
  WEBHOOK_EVENTS,
  assertValidWebhookEvents,
  drainWebhookDeliveries,
  isPublicWebhookUrl,
} from '../lib/webhooks-out';

export interface Env {
  DB: D1Database;
}

const hooks = new Hono<{ Bindings: Env }>();

function endpointView(endpoint: WebhookEndpoint) {
  let events: string[] = [...WEBHOOK_EVENTS];
  try {
    const parsed = JSON.parse(endpoint.events);
    if (Array.isArray(parsed)) events = parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    events = [...WEBHOOK_EVENTS];
  }
  return {
    id: endpoint.id,
    url: endpoint.url,
    events,
    token_id: endpoint.token_id,
    active: !!endpoint.active,
    created_at: endpoint.created_at,
    // The signing secret is write-once: showing it in a list would let any
    // XSS read it and forge events.
    secret: `whsec_${endpoint.secret.slice(0, 4)}…`,
  };
}

hooks.get('/', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const endpoints = await db.listWebhookEndpoints();
  return c.json({ endpoints: endpoints.map(endpointView), events: WEBHOOK_EVENTS });
});

hooks.post('/', async (c) => {
  const db = new DatabaseQueries(c.env.DB);

  try {
    const body = await c.req.json<{ url?: string; events?: string[]; token_id?: string | null }>();
    const url = (body.url ?? '').trim();

    if (!url || url.length > 500) return c.json({ error: 'url is required (max 500 chars)' }, 400);
    // A webhook POST is a request from the mail server: it must not be aimed
    // at the deployment's own private network.
    if (!isPublicWebhookUrl(url)) {
      return c.json({ error: 'url must be a public http(s) endpoint (no private or loopback addresses)' }, 400);
    }

    const events = assertValidWebhookEvents(body.events);
    if (events.length === 0) return c.json({ error: `events must include one of ${WEBHOOK_EVENTS.join(', ')}` }, 400);

    let tokenId: string | null = null;
    if (body.token_id) {
      const token = await db.getApiToken(String(body.token_id));
      if (!token) return c.json({ error: 'unknown token_id' }, 400);
      tokenId = token.id;
    }

    const secret = `whsec_${generateToken(32)}`;
    const id = generateId();
    await db.createWebhookEndpoint({ id, url, secret, events, token_id: tokenId });

    return c.json({
      success: true,
      endpoint: { ...endpointView((await db.getWebhookEndpoint(id))!), secret },
      warning: 'Copy this signing secret now — the full value is never shown again.',
    }, 201);
  } catch (error) {
    console.error('Create webhook endpoint error:', error);
    return c.json({ error: 'Failed to create webhook endpoint' }, 500);
  }
});

hooks.put('/:id', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getWebhookEndpoint(c.req.param('id'));
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404);

  try {
    const body = await c.req.json<{ url?: string; events?: string[]; active?: boolean }>();
    const url = body.url !== undefined ? body.url.trim() : existing.url;
    if (body.url !== undefined && (!isPublicWebhookUrl(url) || url.length > 500)) {
      return c.json({ error: 'url must be a public http(s) endpoint' }, 400);
    }
    const events = body.events !== undefined ? assertValidWebhookEvents(body.events) : JSON.parse(existing.events);
    if (!Array.isArray(events) || events.length === 0) return c.json({ error: 'events must be a non-empty array' }, 400);

    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE webhook_endpoints SET url = ?, events = ?, active = ? WHERE id = ?')
        .bind(url, JSON.stringify(events), body.active === undefined ? existing.active : (body.active ? 1 : 0), existing.id),
    ]);

    return c.json({ success: true, endpoint: endpointView((await db.getWebhookEndpoint(existing.id))!) });
  } catch (error) {
    console.error('Update webhook endpoint error:', error);
    return c.json({ error: 'Failed to update webhook endpoint' }, 500);
  }
});

/** Rotate the signing secret; the old one stops working immediately. */
hooks.post('/:id/rotate-secret', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getWebhookEndpoint(c.req.param('id'));
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404);

  const secret = `whsec_${generateToken(32)}`;
  await db.setWebhookSecret(existing.id, secret);
  return c.json({ success: true, secret, warning: 'Update your receiver before the next event.' });
});

hooks.delete('/:id', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getWebhookEndpoint(c.req.param('id'));
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404);

  await db.deleteWebhookEndpoint(existing.id);
  return c.json({ success: true });
});

/** Recent deliveries, so "did my project get that event?" has an answer. */
hooks.get('/:id/deliveries', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getWebhookEndpoint(c.req.param('id'));
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404);

  const deliveries = await db.listWebhookDeliveries(existing.id, 50);
  return c.json({
    deliveries: deliveries.map(delivery => ({
      id: delivery.id,
      event: delivery.event,
      status: delivery.status,
      attempts: delivery.attempts,
      last_error: delivery.last_error,
      created_at: delivery.created_at,
      next_attempt_at: delivery.next_attempt_at,
      delivered_at: delivery.delivered_at,
    })),
  });
});

/**
 * Queue a sample event and drain it in-request, so the integrator sees the
 * result of their receiver (and its signature check) without waiting for cron.
 */
hooks.post('/:id/test', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getWebhookEndpoint(c.req.param('id'));
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404);

  let events: string[] = [];
  try {
    const parsed = JSON.parse(existing.events);
    if (Array.isArray(parsed)) events = parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    events = [];
  }
  const event = events[0] ?? 'sent';

  const deliveryId = generateId();
  await db.queueWebhookDelivery({
    id: deliveryId,
    endpoint_id: existing.id,
    event,
    payload: JSON.stringify({
      id: deliveryId,
      type: event,
      occurred_at: new Date().toISOString(),
      data: {
        test: true,
        id: '00000000-0000-0000-0000-000000000000',
        to: 'you@example.com',
        subject: 'JMail webhook test',
        message: 'This is a test event; no mail was sent.',
      },
    }),
  });

  const report = await drainWebhookDeliveries(db, 25);
  const delivery = await db.getWebhookDelivery(deliveryId);

  return c.json({
    success: delivery?.status === 'delivered',
    status: delivery?.status ?? 'pending',
    last_error: delivery?.last_error ?? null,
    report,
  });
});

export default hooks;
