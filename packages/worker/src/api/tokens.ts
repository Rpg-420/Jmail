import { Hono } from 'hono';
import { DatabaseQueries, type ApiToken } from '../db/queries';
import { generateId, generateToken, sha256Hex } from '../lib/utils';
import { isValidEmail } from '../lib/validation';
import { utcDay } from '../lib/backoff';

export interface Env {
  DB: D1Database;
}

const SCOPES = ['send', 'read', 'status'] as const;
const TOKEN_PREFIX_LENGTH = 14;

const tokens = new Hono<{ Bindings: Env }>();

/** Strip the hash: the database row must never leave the worker. */
function publicToken(token: ApiToken & { sent_today?: number; failed_today?: number }) {
  return {
    id: token.id,
    name: token.name,
    prefix: token.token_prefix,
    scopes: safeScopes(token.scopes),
    identity_address: token.identity_address,
    rate_per_min: token.rate_per_min,
    daily_budget: token.daily_budget,
    created_at: token.created_at,
    last_used_at: token.last_used_at,
    revoked_at: token.revoked_at,
    sent_today: token.sent_today ?? 0,
    failed_today: token.failed_today ?? 0,
  };
}

function safeScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ['send', 'status'];
    const cleaned = parsed.filter((scope): scope is string => (SCOPES as readonly string[]).includes(scope));
    return cleaned.length ? [...new Set(cleaned)] : ['send', 'status'];
  } catch {
    return ['send', 'status'];
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

tokens.get('/', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const list = await db.listApiTokens(utcDay());
  return c.json({ tokens: list.map(publicToken) });
});

/**
 * Create a token. The plaintext secret is returned exactly once and is
 * stored only as a SHA-256 hash, so it cannot be recovered later.
 */
tokens.post('/', async (c) => {
  const db = new DatabaseQueries(c.env.DB);

  try {
    const body = await c.req.json<{
      name?: string;
      scopes?: string[];
      identity_address?: string | null;
      rate_per_min?: number;
      daily_budget?: number;
    }>();

    const name = (body.name ?? '').trim().slice(0, 60);
    if (!name) return c.json({ error: 'name is required' }, 400);

    const scopes = Array.isArray(body.scopes) && body.scopes.length > 0
      ? [...new Set(body.scopes.filter((scope): scope is string => (SCOPES as readonly string[]).includes(scope)))]
      : ['send', 'status'];
    if (scopes.length === 0) return c.json({ error: `scopes must include one of ${SCOPES.join(', ')}` }, 400);

    let identity: string | null = null;
    if (body.identity_address) {
      const candidate = String(body.identity_address).trim().toLowerCase();
      if (!isValidEmail(candidate)) return c.json({ error: 'identity_address is not a valid email' }, 400);
      identity = candidate;
    }

    const secret = `jmail_${generateToken(24)}`;
    const id = generateId();

    await db.createApiToken({
      id,
      token_hash: await sha256Hex(secret),
      token_prefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
      name,
      scopes,
      identity_address: identity,
      rate_per_min: clampInteger(body.rate_per_min, 1, 120, 60),
      daily_budget: clampInteger(body.daily_budget, 1, 5000, 200),
    });

    const created = await db.getApiToken(id);
    return c.json({
      token: publicToken(created!),
      secret,
      warning: 'Copy this secret now. It is stored hashed and cannot be shown again.',
    }, 201);
  } catch (error) {
    console.error('Create token error:', error);
    return c.json({ error: 'Failed to create token' }, 500);
  }
});

tokens.put('/:id', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getApiToken(c.req.param('id'));
  if (!existing) return c.json({ error: 'Token not found' }, 404);

  try {
    const body = await c.req.json<{
      name?: string;
      scopes?: string[];
      identity_address?: string | null;
      rate_per_min?: number;
      daily_budget?: number;
    }>();

    const name = (body.name ?? existing.name).trim().slice(0, 60) || existing.name;
    const scopes = Array.isArray(body.scopes)
      ? [...new Set(body.scopes.filter((scope): scope is string => (SCOPES as readonly string[]).includes(scope)))]
      : safeScopes(existing.scopes);
    if (scopes.length === 0) return c.json({ error: 'at least one valid scope is required' }, 400);

    let identity = existing.identity_address;
    if (body.identity_address !== undefined) {
      if (body.identity_address === null || body.identity_address === '') {
        identity = null;
      } else {
        const candidate = String(body.identity_address).trim().toLowerCase();
        if (!isValidEmail(candidate)) return c.json({ error: 'identity_address is not a valid email' }, 400);
        identity = candidate;
      }
    }

    await db.updateApiToken(existing.id, {
      name,
      scopes,
      identity_address: identity,
      rate_per_min: clampInteger(body.rate_per_min, 1, 120, existing.rate_per_min),
      daily_budget: clampInteger(body.daily_budget, 1, 5000, existing.daily_budget),
    });

    return c.json({ success: true, token: publicToken((await db.getApiToken(existing.id))!) });
  } catch (error) {
    console.error('Update token error:', error);
    return c.json({ error: 'Failed to update token' }, 500);
  }
});

/** Revocation is soft: history stays queryable, the secret stops working. */
tokens.post('/:id/revoke', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getApiToken(c.req.param('id'));
  if (!existing) return c.json({ error: 'Token not found' }, 404);

  await db.revokeApiToken(existing.id);
  return c.json({ success: true });
});

tokens.get('/:id/usage', async (c) => {
  const db = new DatabaseQueries(c.env.DB);
  const existing = await db.getApiToken(c.req.param('id'));
  if (!existing) return c.json({ error: 'Token not found' }, 404);

  const rawDays = Number.parseInt(c.req.query('days') || '14', 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 14;
  const history = await db.listTokenUsageHistory(existing.id, days);

  return c.json({
    token: publicToken(existing),
    days,
    history,
    totals: history.reduce(
      (sum, day) => ({ sent: sum.sent + day.sent, failed: sum.failed + day.failed }),
      { sent: 0, failed: 0 }
    ),
  });
});

export default tokens;
