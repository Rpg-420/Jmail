import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import auth, { authMiddleware } from './auth';
import webauthn from './webauthn';
import emails from './emails';
import settings from './settings';
import setup from './setup';
import push from './push';
import webhooks from './webhooks';
import contacts from './contacts';
import folders from './folders';
import v1 from './v1';
import tokens from './tokens';
import providers from './providers';
import hooks from './hooks';
import { RateLimiter, getClientIP } from '../lib/rate-limit';

export interface Env {
  DB: D1Database;
  ATTACHMENTS?: R2Bucket;
}

const api = new Hono<{ Bindings: Env }>();

// Security headers
api.use('/*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  crossOriginEmbedderPolicy: false, // Disable for compatibility
}));

// Private API responses must never enter shared/browser caches. Reject cross-origin
// mutations before any handler runs (including login and provider configuration).
api.use('/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  const origin = c.req.header('Origin');
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !c.req.path.startsWith('/api/webhooks/')) {
    const expected = new URL(c.req.url).origin;
    const localDev = ['localhost', '127.0.0.1'].includes(new URL(expected).hostname) &&
      ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
    if (origin !== expected && !localDev) return c.json({ error: 'Cross-origin request rejected' }, 403);
  }
  await next();
});

// CORS - the SPA is served from the same origin as the API, so only
// same-host requests and local dev servers are allowed.
api.use('/*', cors({
  origin: (origin, c) => {
    // No Origin header means the caller isn't a browser making a cross-origin
    // read — answering '*' would put that header on authenticated responses.
    if (!origin) return null;
    try {
      const originUrl = new URL(origin);
      const requestHost = new URL(c.req.url).hostname;
      const isSameHost = originUrl.origin === new URL(c.req.url).origin;
      const isLocalDev = ['localhost', '127.0.0.1'].includes(requestHost) && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
      return isSameHost || isLocalDev ? origin : null;
    } catch {
      return null;
    }
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // 24 hours
}));

/**
 * Rate limit middleware factory backed by D1.
 *
 * `clearOnSuccess` matters for a single-admin box: the budget protects against
 * brute force, and without it five *correct* logins in fifteen minutes would
 * lock the owner out of their own mail.
 */
function rateLimit(config: { windowMs: number; maxRequests: number; keyPrefix: string; clearOnSuccess?: boolean }) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const rateLimiter = new RateLimiter(c.env.DB, config);
    const ip = getClientIP(c.req.raw);
    const result = await rateLimiter.check(ip);

    if (!result.allowed) {
      return c.json(
        {
          error: 'Too many attempts. Please try again later.',
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
        },
        429
      );
    }

    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetTime / 1000)));

    await next();

    // A successful login clears the budget, so one typo does not lock the owner
    // out for the rest of the window.
    if (config.clearOnSuccess && c.res.status >= 200 && c.res.status < 300) {
      await rateLimiter.reset(ip);
    }
  };
}

// Login attempts (password and passkey share one budget): 5 failures per 15 minutes
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'login',
  clearOnSuccess: true,
});
api.use('/auth/login', loginRateLimit);
api.use('/auth/webauthn/login/verify', loginRateLimit);

// Assertion options mint a stored challenge each call, so it gets its own —
// generous — budget instead of being public and unbounded.
api.use('/auth/webauthn/login/options', rateLimit({
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'webauthn-options',
}));

// Setup: 3 attempts per hour
api.use('/auth/setup', rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 3,
  keyPrefix: 'setup',
}));

// Public routes (webauthn manages its own per-route auth)
api.route('/auth/webauthn', webauthn);
api.route('/auth', auth);

// Brevo delivery webhooks (secret-in-path, no session auth)
api.use('/webhooks/*', rateLimit({ windowMs: 60 * 1000, maxRequests: 120, keyPrefix: 'inboundhook' }));
api.route('/webhooks', webhooks);

// Mail-server API for other projects. Bearer-token authenticated inside the
// module, so it must stay outside the session middleware.
api.route('/v1', v1);

// Health check
api.get('/health', (c) => {
  const seconds = Math.floor(Date.now() / 1000);
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    next_utc_midnight: Math.floor(Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1
    ) / 1000) - seconds,
  });
});

// Protected routes - require authentication
api.use('/emails/*', async (c, next) => {
  return authMiddleware(c, next);
});

api.use('/settings/*', async (c, next) => {
  return authMiddleware(c, next);
});

// The whole setup surface (including /setup/status, which reveals domain and
// configuration state) requires an authenticated session.
api.use('/setup/*', async (c, next) => {
  return authMiddleware(c, next);
});

api.use('/push/*', async (c, next) => {
  return authMiddleware(c, next);
});

api.use('/contacts/*', async (c, next) => {
  return authMiddleware(c, next);
});

api.use('/folders/*', authMiddleware);
api.use('/tokens/*', authMiddleware);
api.use('/providers/*', authMiddleware);
api.use('/hooks/*', authMiddleware);
api.route('/folders', folders);
api.route('/emails', emails);
api.route('/settings', settings);
api.route('/setup', setup);
api.route('/push', push);
api.route('/contacts', contacts);
api.route('/tokens', tokens);
api.route('/providers', providers);
api.route('/hooks', hooks);

// 404 handler
api.all('*', (c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default api;
