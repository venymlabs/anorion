import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { agentRegistry } from '../agents/registry';
import { toolRegistry } from '../tools/registry';
import { sessionManager } from '../agents/session';
import { sendMessage } from '../agents/runtime';
import { channelRouter } from '../channels/router';
import { logger } from '../shared/logger';
import { scheduleManager } from '../scheduler/cron';
import { memoryManager } from '../memory/store';
import { spawnSubAgent, listChildren, killChild } from '../agents/subagent';

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

  // Allow if no keys configured or only default dev keys
  const hasRealKeys = [...validKeys.keys()].some((k) => k !== 'anorion-dev-key');
  if (!hasRealKeys) return next();

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

// Resolve agent by ID or name
function resolveAgent(idOrName: string) {
  return agentRegistry.get(idOrName) || agentRegistry.getByName(idOrName);
}

// Get agent
app.get('/api/v1/agents/:id', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent });
});

// Update agent
app.patch('/api/v1/agents/:id', async (c) => {
  const body = await c.req.json();
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const updated = await agentRegistry.update(agent.id, body);

  if (body.tools) {
    toolRegistry.bindTools(agent.id, body.tools);
  }

  return c.json({ agent: updated });
});

// Delete agent
app.delete('/api/v1/agents/:id', async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  await agentRegistry.delete(agent.id);
  return c.json({ ok: true });
});

// Send message to agent
app.post('/api/v1/agents/:id/messages', async (c) => {
  const body = await c.req.json();
  if (!body.text) return c.json({ error: 'text is required' }, 400);

  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  try {
    const result = await sendMessage({
      agentId: agent.id,
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
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const sessions = await sessionManager.listByAgent(agent.id);
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

// Channel management
app.get('/api/v1/channels', (c) => {
  return c.json({ channels: channelRouter.listChannels() });
});

app.post('/api/v1/channels/:name/start', async (c) => {
  const name = c.req.param('name');
  const ok = await channelRouter.startChannel(name);
  if (!ok) return c.json({ error: `Channel not found: ${name}` }, 404);
  return c.json({ ok: true, channel: name });
});

app.post('/api/v1/channels/:name/stop', async (c) => {
  const name = c.req.param('name');
  const ok = await channelRouter.stopChannel(name);
  if (!ok) return c.json({ error: `Channel not found: ${name}` }, 404);
  return c.json({ ok: true, channel: name });
});

// ── Schedules ──

app.post('/api/v1/schedules', async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.agentId || !body.schedule || !body.payload) {
    return c.json({ error: 'name, agentId, schedule, and payload are required' }, 400);
  }
  try {
    const job = await scheduleManager.create(body);
    return c.json({ schedule: job }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get('/api/v1/schedules', (c) => c.json({ schedules: scheduleManager.list() }));

app.get('/api/v1/schedules/:id', (c) => {
  const job = scheduleManager.get(c.req.param('id'));
  if (!job) return c.json({ error: 'Schedule not found' }, 404);
  return c.json({ schedule: job });
});

app.patch('/api/v1/schedules/:id', async (c) => {
  const body = await c.req.json();
  try {
    const updated = await scheduleManager.update(c.req.param('id'), body);
    if (!updated) return c.json({ error: 'Schedule not found' }, 404);
    return c.json({ schedule: updated });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete('/api/v1/schedules/:id', async (c) => {
  const ok = await scheduleManager.remove(c.req.param('id'));
  if (!ok) return c.json({ error: 'Schedule not found' }, 404);
  return c.json({ ok: true });
});

app.post('/api/v1/schedules/:id/trigger', async (c) => {
  const result = await scheduleManager.trigger(c.req.param('id'));
  if (!result.success) return c.json({ error: result.error }, 404);
  return c.json({ triggered: true });
});

// ── Memory ──

app.get('/api/v1/agents/:id/memory', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ memories: memoryManager.load(agent.id) });
});

app.post('/api/v1/agents/:id/memory', async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const body = await c.req.json();
  if (!body.key || body.value === undefined) {
    return c.json({ error: 'key and value are required' }, 400);
  }
  const entry = memoryManager.save(agent.id, body.category || 'fact', body.key, body.value);
  return c.json({ memory: entry }, 201);
});

app.post('/api/v1/agents/:id/memory/search', async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const body = await c.req.json();
  return c.json({ memories: memoryManager.search(agent.id, body.query || '') });
});

app.delete('/api/v1/agents/:id/memory/:key', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const ok = memoryManager.forget(agent.id, c.req.param('key'));
  if (!ok) return c.json({ error: 'Memory not found' }, 404);
  return c.json({ ok: true });
});

// ── Sub-agents ──

app.get('/api/v1/agents/:id/children', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ children: listChildren(agent.id) });
});

app.post('/api/v1/agents/:id/spawn', async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const body = await c.req.json();
  if (!body.prompt) return c.json({ error: 'prompt is required' }, 400);
  try {
    const result = await spawnSubAgent({
      parentId: agent.id,
      prompt: body.prompt,
      ttl: body.ttl_seconds ? body.ttl_seconds * 1000 : undefined,
      systemPrompt: body.systemPrompt,
    });
    return c.json({ result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.delete('/api/v1/agents/:id/children/:childId', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const ok = killChild(agent.id, c.req.param('childId'));
  if (!ok) return c.json({ error: 'Child not found' }, 404);
  return c.json({ ok: true });
});

// ── Bridge ──

let federatorRef: import('../bridge/federator').Federator | null = null;

export function setBridge(federator: import('../bridge/federator').Federator) {
  federatorRef = federator;
}

export function registerBridgeRoutes(hono: Hono) {
  hono.get('/api/v1/bridge/status', (c) => {
    if (!federatorRef) return c.json({ enabled: false });
    return c.json(federatorRef.getStatus());
  });

  hono.get('/api/v1/bridge/peers', (c) => {
    if (!federatorRef) return c.json({ peers: [] });
    return c.json({ peers: federatorRef.getPeers() });
  });

  hono.post('/api/v1/bridge/peers', async (c) => {
    const body = await c.req.json();
    if (!body.url) return c.json({ error: 'url is required' }, 400);
    if (!federatorRef) return c.json({ error: 'Bridge not enabled' }, 400);
    await federatorRef.connectPeer(body.url, body.secret || '');
    return c.json({ ok: true, url: body.url });
  });

  hono.delete('/api/v1/bridge/peers/:id', (c) => {
    if (!federatorRef) return c.json({ error: 'Bridge not enabled' }, 400);
    const id = c.req.param('id');
    for (const peer of federatorRef.getPeers()) {
      if (peer.id === id) {
        federatorRef.disconnectPeer(peer.url);
        return c.json({ ok: true });
      }
    }
    return c.json({ error: 'Peer not found' }, 404);
  });

  hono.get('/api/v1/bridge/agents', (c) => {
    if (!federatorRef) return c.json({ local: agentRegistry.list(), remote: [] });
    return c.json(federatorRef.getAllAgents());
  });

  hono.post('/api/v1/bridge/agents/:id/messages', async (c) => {
    const body = await c.req.json();
    if (!body.text) return c.json({ error: 'text is required' }, 400);
    if (!federatorRef) return c.json({ error: 'Bridge not enabled' }, 400);
    try {
      const result = await federatorRef.routeMessage(c.req.param('id'), body.text, body.sessionId, body.channelId);
      if (result.error) return c.json({ error: result.error }, 500);
      return c.json({ content: result.content });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}

export default app;
export type AppType = typeof app;
