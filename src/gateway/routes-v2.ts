// Extended API routes for Wave 2 features
// These get mounted onto the main Hono app

import { Hono } from 'hono';
import { metrics } from '../shared/metrics';
import { auditLog } from '../shared/audit';
import { tokenBudget } from '../shared/token-budget';
import { apiKeyManager } from '../shared/rbac';
import { skillManager } from '../tools/skill-manager';
import { listPipelines, getPipeline, executePipeline, registerPipeline } from '../agents/pipeline';
import { logger } from '../shared/logger';

const app = new Hono();

// ── Prometheus Metrics ──
app.get('/metrics', (c) => {
  const text = metrics.render();
  return c.text(text, 200, { 'Content-Type': 'text/plain; version=0.0.4' });
});

// ── Stats Dashboard ──
app.get('/api/v1/stats', (c) => {
  return c.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    tokens: tokenBudget.getGlobalUsage(),
    audit: auditLog.getStats(),
  });
});

// ── Audit Log ──
app.get('/api/v1/audit', (c) => {
  const entries = auditLog.query({
    agentId: c.req.query('agentId'),
    sessionId: c.req.query('sessionId'),
    action: c.req.query('action'),
    since: c.req.query('since'),
    until: c.req.query('until'),
    limit: Number(c.req.query('limit')) || 100,
    offset: Number(c.req.query('offset')) || 0,
  });
  return c.json({ entries });
});

app.get('/api/v1/audit/stats', (c) => {
  return c.json(auditLog.getStats());
});

app.delete('/api/v1/audit', async (c) => {
  const days = Number(c.req.query('retentionDays')) || 30;
  const deleted = auditLog.purge(days);
  return c.json({ deleted });
});

// ── Token Budget ──
app.get('/api/v1/tokens', (c) => {
  return c.json({
    global: tokenBudget.getGlobalUsage(),
    config: tokenBudget.getConfig(),
  });
});

app.get('/api/v1/tokens/:agentId', (c) => {
  const usage = tokenBudget.getUsage(c.req.param('agentId'));
  return c.json({ usage });
});

app.patch('/api/v1/tokens/config', async (c) => {
  const body = await c.req.json();
  tokenBudget.updateConfig(body);
  return c.json({ config: tokenBudget.getConfig() });
});

app.post('/api/v1/tokens/:agentId/reset', (c) => {
  tokenBudget.resetAgent(c.req.param('agentId'));
  return c.json({ ok: true });
});

// ── API Keys (RBAC) ──
app.get('/api/v1/keys', (c) => {
  return c.json({ keys: apiKeyManager.list() });
});

app.post('/api/v1/keys', async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.role) return c.json({ error: 'name and role are required' }, 400);
  const result = apiKeyManager.create({
    name: body.name,
    role: body.role,
    permissions: body.permissions,
  });
  return c.json({ key: result.key, entry: result.entry }, 201);
});

app.delete('/api/v1/keys/:id', (c) => {
  const ok = apiKeyManager.revoke(c.req.param('id'));
  if (!ok) return c.json({ error: 'Key not found' }, 404);
  return c.json({ ok: true });
});

app.get('/api/v1/keys/roles', (c) => {
  return c.json({ roles: apiKeyManager.getRoles() });
});

// ── Skills ──
app.get('/api/v1/skills', (c) => {
  return c.json({ skills: skillManager.list() });
});

app.post('/api/v1/skills/:name/reload', async (c) => {
  const ok = await skillManager.reload(c.req.param('name'));
  if (!ok) return c.json({ error: 'Skill not found or reload failed' }, 404);
  return c.json({ ok: true });
});

app.patch('/api/v1/skills/:name', async (c) => {
  const body = await c.req.json();
  if (body.enabled !== undefined) {
    skillManager.setEnabled(c.req.param('name'), body.enabled);
  }
  if (body.config) {
    skillManager.setSkillConfig(c.req.param('name'), body.config);
  }
  return c.json({ ok: true });
});

// ── Pipelines ──
app.get('/api/v1/pipelines', (c) => {
  return c.json({ pipelines: listPipelines() });
});

app.get('/api/v1/pipelines/:name', (c) => {
  const pipeline = getPipeline(c.req.param('name'));
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404);
  return c.json({ pipeline });
});

app.post('/api/v1/pipelines', async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.steps || !Array.isArray(body.steps)) {
    return c.json({ error: 'name and steps array are required' }, 400);
  }
  registerPipeline({
    name: body.name,
    description: body.description,
    steps: body.steps,
    chainMode: body.chainMode || 'last-output',
    onFailure: body.onFailure || 'stop',
    maxRetries: body.maxRetries || 0,
  });
  return c.json({ ok: true }, 201);
});

app.post('/api/v1/pipelines/:name/execute', async (c) => {
  const body = await c.req.json();
  if (!body.input) return c.json({ error: 'input is required' }, 400);
  try {
    const result = await executePipeline(c.req.param('name'), body.input, body.sessionId);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default app;
