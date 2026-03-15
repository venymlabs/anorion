import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { agentRegistry } from '../agents/registry';
import { toolRegistry } from '../tools/registry';
import { sessionManager } from '../agents/session';
import { sendMessage } from '../agents/runtime';
import { logger } from '../shared/logger';

const app = new Hono();

// CORS
app.use('*', cors());

// Auth middleware
const validKeys = new Map<string, string[]>();
export function setApiKeys(keys: { name: string; key: string; scopes: string[] }[]) {
  for (const k of keys) {
    validKeys.set(k.key, k.scopes);
  }
}

const noAuthPaths = ['/health'];

app.use('*', async (c, next) => {
  if (noAuthPaths.includes(c.req.path)) return next();

  // Allow if no keys configured
  if (validKeys.size === 0) return next();

  const apiKey = c.req.header('X-API-Key');
  if (!apiKey || !validKeys.has(apiKey)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
});

// Health
app.get('/health', (c) => c.json({
  status: 'ok',
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
  agents: agentRegistry.list().length,
}));

// List agents
app.get('/api/v1/agents', (c) => {
  return c.json({ agents: agentRegistry.list() });
});

// Create agent
app.post('/api/v1/agents', async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: 'name is required' }, 400);

  const agent = await agentRegistry.create({
    name: body.name,
    model: body.model || 'openai/gpt-4o',
    systemPrompt: body.systemPrompt || 'You are a helpful assistant.',
    tools: body.tools || [],
    maxIterations: body.maxIterations || 10,
    timeoutMs: body.timeoutMs || 120000,
    tags: body.tags,
    metadata: body.metadata,
  });

  // Bind tools
  if (agent.tools.length > 0) {
    toolRegistry.bindTools(agent.id, agent.tools);
  }

  return c.json({ agent }, 201);
});

// Get agent
app.get('/api/v1/agents/:id', (c) => {
  const agent = agentRegistry.get(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent });
});

// Update agent
app.patch('/api/v1/agents/:id', async (c) => {
  const body = await c.req.json();
  const agent = await agentRegistry.update(c.req.param('id'), body);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  if (body.tools) {
    toolRegistry.bindTools(agent.id, body.tools);
  }

  return c.json({ agent });
});

// Delete agent
app.delete('/api/v1/agents/:id', async (c) => {
  const deleted = await agentRegistry.delete(c.req.param('id'));
  if (!deleted) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ ok: true });
});

// Send message to agent
app.post('/api/v1/agents/:id/messages', async (c) => {
  const body = await c.req.json();
  if (!body.text) return c.json({ error: 'text is required' }, 400);

  try {
    const result = await sendMessage({
      agentId: c.req.param('id'),
      sessionId: body.sessionId,
      text: body.text,
      channelId: body.channelId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Message failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});

// List sessions
app.get('/api/v1/agents/:id/sessions', async (c) => {
  const sessions = await sessionManager.listByAgent(c.req.param('id'));
  return c.json({ sessions });
});

// List tools
app.get('/api/v1/tools', (c) => {
  return c.json({
    tools: toolRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      category: t.category,
    })),
  });
});

// 404
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
export type AppType = typeof app;
