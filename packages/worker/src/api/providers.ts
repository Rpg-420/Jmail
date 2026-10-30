import { Hono } from 'hono';
import { BrevoAPI } from '@jmail/brevo-api';
import { DatabaseQueries } from '../db/queries';
import { ensureBrevoWebhook } from '../lib/brevo-webhook';
import { isValidApiKey } from '../lib/validation';
import {
  listProviderStatuses,
  providerLabel,
  verifyProviderKey,
  type ProviderStatus,
} from '../lib/providers';
import { PROVIDER_IDS } from '../lib/providers';
import type { ProviderId } from '../lib/providers/types';

export interface Env {
  DB: D1Database;
}

const providers = new Hono<{ Bindings: Env }>();

function keySetting(id: string): string {
  return `provider_key_${id}`;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Masked view: the relay secret never leaves the worker. */
function providerView(status: ProviderStatus) {
  return {
    id: status.id,
    label: status.label,
    configured: status.configured,
    quota_day: status.quotaDay,
    quota_month: status.quotaMonth,
    used_day: status.usedDay,
    used_month: status.usedMonth,
    remaining_day: status.remaining,
    max_recipients: status.maxRecipients,
    max_message_mb: Math.round(status.maxMessageBytes / 1024 / 1024),
  };
}

providers.get('/', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const statuses = await listProviderStatuses(db);
  const queue = await db.queueSummary();
  const history = await db.listProviderUsageHistory(14);

  return c.json({
    providers: statuses.map(providerView),
    total_remaining_today: statuses.reduce((sum, status) => sum + (status.remaining ?? 0), 0),
    queue: Object.fromEntries(queue.map(row => [row.status, row.count])),
    history,
  });
});

/**
 * Save a relay key. The key is checked live first — a typo in a secret is
 * far cheaper to discover here than in the cron two hours later.
 */
providers.put('/:id/key', async (c) => {
  const id = c.req.param('id');
  if (!isProviderId(id)) return c.json({ error: 'Unknown provider' }, 404);

  const db = new DatabaseQueries(c.env.DB);
  const body = await c.req.json<{ apiKey?: string }>().catch(() => null);
  const apiKey = (body?.apiKey ?? '').trim();

  if (!apiKey) {
    await c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(keySetting(id)).run();
    return c.json({ success: true, configured: false });
  }
  if (!isValidApiKey(apiKey)) return c.json({ error: 'API key format is not valid' }, 400);

  try {
    await verifyProviderKey(db, id, apiKey);
  } catch (error) {
    return c.json(
      { error: 'Provider rejected this key', details: (error as Error).message.slice(0, 300) },
      400
    );
  }

  await db.setSetting(keySetting(id), apiKey);
  // The legacy single-provider setting must not shadow the new one.
  if (id === 'brevo') {
    await db.deleteSetting('brevo_api_key');
    // Saving the key is also how delivery tracking gets (re)registered, so the
    // Mail-server screen behaves exactly like the setup wizard does.
    await ensureBrevoWebhook(db, new BrevoAPI({ apiKey }), c.req.url);
  }

  return c.json({ success: true, configured: true, label: providerLabel(id) });
});

providers.put('/:id/quota', async (c) => {
  const id = c.req.param('id');
  if (!isProviderId(id)) return c.json({ error: 'Unknown provider' }, 404);

  const db = new DatabaseQueries(c.env.DB);
  const body = await c.req.json<{ day?: number | null; month?: number | null }>().catch(() => null);
  if (!body) return c.json({ error: 'Invalid body' }, 400);

  const statements = [];
  for (const [kind, raw] of [['day', body.day], ['month', body.month]] as const) {
    const key = `provider_quota_${id}_${kind}`;
    if (raw === null || raw === undefined || raw === 0) {
      statements.push(c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key));
    } else {
      const value = Math.min(Math.max(Math.round(Number(raw)), 1), 100_000);
      if (!Number.isFinite(value)) return c.json({ error: `${kind} quota must be a number` }, 400);
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(key, String(value))
      );
    }
  }
  await c.env.DB.batch(statements);

  const status = (await listProviderStatuses(db)).find(item => item.id === id);
  return c.json({ success: true, provider: status ? providerView(status) : null });
});

/** Failover order — first provider is tried first, the rest are fallbacks. */
providers.put('/order', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const body = await c.req.json<{ order?: string[] }>().catch(() => null);
  const requested = Array.isArray(body?.order) ? body!.order!.filter(isProviderId) : [];
  const order = [...new Set([...requested, ...PROVIDER_IDS])];
  await db.setSetting('provider_order', JSON.stringify(order));
  return c.json({ success: true, order });
});

export default providers;
