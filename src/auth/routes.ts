// Auth routes — login, register, key management, health

import { Hono } from 'hono';
import { signJwt } from './jwt';
import { createApiKeyMemory, listApiKeysMemory, revokeApiKeyMemory, verifyApiKeyMemory } from './api-keys';
import { authMiddleware, requireScope, rateLimitPerKey } from './middleware';
import type { AuthContext, CreateKeyRequest, LoginRequest, RegisterRequest } from './types';

const app = new Hono();

// ── Public health check ──
app.get('/api/v1/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });
});

// ── Detailed health (requires auth) ──
app.get('/api/v1/health/detailed', authMiddleware, (c) => {
  const mem = process.memoryUsage();
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
      heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
    },
    nodeVersion: process.version,
    pid: process.pid,
  });
});

// ── Login: exchange API key for JWT ──
app.post('/api/v1/auth/login', rateLimitPerKey(10), async (c) => {
  const body = await c.req.json() as LoginRequest;
  if (!body.apiKey) return c.json({ error: 'apiKey is required' }, 400);

  const key = verifyApiKeyMemory(body.apiKey);
  if (!key) return c.json({ error: 'Invalid API key' }, 401);

  const token = await signJwt({
    sub: key.userId || key.id,
    username: key.name,
    role: 'agent',
    scopes: key.scopes,
  });

  return c.json({
    token,
    expiresIn: 3600,
    scopes: key.scopes,
  });
});

// ── Register: create a user (admin only) ──
app.post('/api/v1/auth/register', authMiddleware, requireScope('admin'), async (c) => {
  const body = await c.req.json() as RegisterRequest;
  if (!body.username) return c.json({ error: 'username is required' }, 400);

  // In this simplified version, registration creates an API key for the user
  const role = body.role || 'viewer';
  const scopes = role === 'admin' ? ['read', 'write', 'admin'] as const
    : role === 'operator' ? ['read', 'write'] as const
    : ['read'] as const;

  const result = createApiKeyMemory('', body.username, [...scopes]);

  return c.json({
    user: {
      username: body.username,
      role,
    },
    apiKey: result.key,
    apiKeyId: result.apiKey.id,
  }, 201);
});

// ── Get current auth info ──
app.get('/api/v1/auth/me', authMiddleware, (c) => {
  const auth = c.get('auth') as AuthContext;
  return c.json({
    userId: auth.userId,
    username: auth.username,
    role: auth.role,
    scopes: auth.scopes,
  });
});

// ── API Key management ──

// Create API key
app.post('/api/v1/keys', authMiddleware, requireScope('admin'), async (c) => {
  const body = await c.req.json() as CreateKeyRequest;
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  if (!body.scopes || body.scopes.length === 0) return c.json({ error: 'scopes are required' }, 400);

  const auth = c.get('auth') as AuthContext;
  const result = createApiKeyMemory(auth.userId, body.name, body.scopes);

  return c.json({
    key: result.key,
    apiKey: {
      id: result.apiKey.id,
      name: result.apiKey.name,
      scopes: result.apiKey.scopes,
      createdAt: result.apiKey.createdAt,
    },
  }, 201);
});

// List API keys
app.get('/api/v1/keys', authMiddleware, requireScope('read'), (c) => {
  const keys = listApiKeysMemory().map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: k.scopes,
    enabled: k.enabled,
    lastUsed: k.lastUsed,
    createdAt: k.createdAt,
  }));
  return c.json({ keys });
});

// Revoke API key
app.delete('/api/v1/keys/:id', authMiddleware, requireScope('admin'), (c) => {
  const id = c.req.param('id')!;
  const ok = revokeApiKeyMemory(id);
  if (!ok) return c.json({ error: 'Key not found' }, 404);
  return c.json({ ok: true });
});

export default app;
