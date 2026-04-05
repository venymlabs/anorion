// Auth middleware for Hono — JWT bearer, API key, scope validation, rate limiting

import type { Context, Next } from 'hono';
import type { ApiKeyScope, AuthContext } from './types';
import { verifyJwt } from './jwt';
import { verifyApiKeyMemory, listApiKeysMemory } from './api-keys';

// Extend Hono context variables
declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// ── Public paths that skip auth ──
const PUBLIC_PATHS = new Set([
  '/api/v1/health',
  '/health',
  '/metrics',
]);

// ── Extract auth context from request ──
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  // Skip auth for public paths
  if (PUBLIC_PATHS.has(c.req.path)) return next();

  // Dev mode: if no keys configured, allow all
  const allKeys = listApiKeysMemory();
  const hasRealKeys = allKeys.length > 0;
  if (!hasRealKeys) {
    c.set('auth', {
      userId: 'dev',
      username: 'dev',
      role: 'admin',
      scopes: ['read', 'write', 'admin'],
    });
    return next();
  }

  // Try API key auth first (X-API-Key header or Authorization: Bearer sk-.../anr_...)
  const apiKeyHeader = c.req.header('X-API-Key');
  const authHeader = c.req.header('Authorization') || '';

  let authCtx: AuthContext | null = null;

  if (apiKeyHeader) {
    const key = verifyApiKeyMemory(apiKeyHeader);
    if (key) {
      authCtx = {
        userId: key.userId,
        username: key.name,
        role: 'agent',
        scopes: key.scopes,
        apiKeyId: key.id,
      };
    }
  } else if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // Check if it's an API key (starts with anr_)
    if (token.startsWith('anr_') || token.startsWith('sk-')) {
      const key = verifyApiKeyMemory(token);
      if (key) {
        authCtx = {
          userId: key.userId,
          username: key.name,
          role: 'agent',
          scopes: key.scopes,
          apiKeyId: key.id,
        };
      }
    } else {
      // Try JWT
      const payload = await verifyJwt(token);
      if (payload) {
        authCtx = {
          userId: payload.sub,
          username: payload.username,
          role: payload.role,
          scopes: payload.scopes,
        };
      }
    }
  }

  if (!authCtx) {
    return c.json({ error: 'Unauthorized', message: 'Valid API key or JWT token required' }, 401);
  }

  c.set('auth', authCtx);
  return next();
}

// ── Scope validation middleware ──
export function requireScope(...requiredScopes: ApiKeyScope[]) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    // Admin scope grants all
    if (auth.scopes.includes('admin')) return next();

    const hasScope = requiredScopes.some((s) => auth.scopes.includes(s));
    if (!hasScope) {
      return c.json({ error: 'Forbidden', message: `Requires one of: ${requiredScopes.join(', ')}` }, 403);
    }

    return next();
  };
}

// ── Rate limiting per key (in-memory sliding window) ──
interface RateWindow {
  timestamps: number[];
  tokenCount: number;
}

const rateWindows = new Map<string, RateWindow>();

export function rateLimitPerKey(rpm: number = 60, tpm: number = 100000) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.get('auth');
    const keyId = auth?.apiKeyId || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    const now = Date.now();
    const windowMs = 60_000; // 1 minute sliding window

    let bucket = rateWindows.get(keyId);
    if (!bucket) {
      bucket = { timestamps: [], tokenCount: 0 };
      rateWindows.set(keyId, bucket);
    }

    // Slide window
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

    if (bucket.timestamps.length >= rpm) {
      const oldest = bucket.timestamps[0]!;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      return c.json({ error: 'Rate limit exceeded', retryAfter }, 429, { 'Retry-After': String(retryAfter) });
    }

    bucket.timestamps.push(now);
    return next();
  };
}

// Periodic cleanup of old buckets (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateWindows) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 120_000);
    if (bucket.timestamps.length === 0) rateWindows.delete(key);
  }
}, 300_000);
