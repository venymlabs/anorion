import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { agentRegistry } from '../agents/registry';
import { toolRegistry } from '../tools/registry';
import { sessionManager } from '../agents/session';
import { sendMessage, streamMessage } from '../agents/runtime';
import { channelRouter } from '../channels/router';
import { logger } from '../shared/logger';
import { scheduleManager } from '../scheduler/cron';
import { memoryManager } from '../memory/store';
import { spawnSubAgent, listChildren, killChild } from '../agents/subagent';

const app = new Hono();

// ── Zod Schemas ──

const CreateAgentSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional().default('openai/gpt-4o'),
  systemPrompt: z.string().optional().default('You are a helpful assistant.'),
  tools: z.array(z.string()).optional().default([]),
  maxIterations: z.number().int().min(1).max(100).optional().default(10 as any as never),
  timeoutMs: z.number().int().min(1000).optional().default(120000 as any as never),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const SendMessageSchema = z.object({
  text: z.string().min(1),
  sessionId: z.string().optional(),
  channelId: z.string().optional(),
});

const CreateScheduleSchema = z.object({
  name: z.string().min(1),
  agentId: z.string().min(1),
  schedule: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional().default(true as any as never),
});

const SaveMemorySchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  category: z.string().optional().default('fact'),
});

const SpawnSchema = z.object({
  prompt: z.string().min(1),
  ttl_seconds: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),
});

const StreamSchema = z.object({
  text: z.string().min(1),
  sessionId: z.string().optional(),
  channelId: z.string().optional(),
});

// ── Validation Helper ──

function validate<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: any } {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error.flatten() };
}

// ── Rate Limiting ──

interface RateBucket {
  timestamps: number[];
}

const rateBuckets = new Map<string, RateBucket>();

function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: any, next: any) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || c.req.header('cf-connecting-ip')
      || 'unknown';

    const now = Date.now();
    const bucket = rateBuckets.get(ip) || { timestamps: [] };

    // Slide window: keep only timestamps within window
    bucket.timestamps = bucket.timestamps.filter((t: number) => now - t < windowMs);

    if (bucket.timestamps.length >= maxRequests) {
      const oldest = bucket.timestamps[0]!;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(retryAfter) });
    }

    bucket.timestamps.push(now);
    rateBuckets.set(ip, bucket);

    return next();
  };
}

const messageRateLimit = rateLimit(60, 60_000);  // 60 req/min
const readRateLimit = rateLimit(120, 60_000);     // 120 req/min

// ── CORS ──
app.use('*', cors());

// ── Auth Middleware ──

const validKeys = new Map<string, string[]>();
export function setApiKeys(keys: { name: string; key: string; scopes: string[] }[]) {
  for (const k of keys) {
    validKeys.set(k.key, k.scopes);
  }
}

const noAuthPaths = ['/health'];

app.use('*', async (c, next) => {
  if (noAuthPaths.includes(c.req.path)) return next();

  const hasRealKeys = [...validKeys.keys()].some((k) => k !== 'anorion-dev-key');
  if (!hasRealKeys) return next();

  const apiKey = c.req.header('X-API-Key');
  if (!apiKey || !validKeys.has(apiKey)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
});

// ── Health ──
app.get('/health', readRateLimit, (c) => c.json({
  status: 'ok',
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
  agents: agentRegistry.list().length,
}));

// ── Agents ──

app.get('/api/v1/agents', readRateLimit, (c) => {
  return c.json({ agents: agentRegistry.list() });
});

app.post('/api/v1/agents', messageRateLimit, async (c) => {
  const body = await c.req.json();
  const parsed = validate(CreateAgentSchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }

  const data = parsed.data;
  const agent = await agentRegistry.create({
    id: crypto.randomUUID().slice(0, 10),
    name: data.name,
    model: data.model,
    systemPrompt: data.systemPrompt,
    tools: data.tools,
    maxIterations: data.maxIterations,
    timeoutMs: data.timeoutMs,
    tags: data.tags,
    metadata: data.metadata,
  } as any);

  if (agent.tools.length > 0) {
    toolRegistry.bindTools(agent.id, agent.tools);
  }

  return c.json({ agent }, 201);
});

function resolveAgent(idOrName: string) {
  return agentRegistry.get(idOrName) || agentRegistry.getByName(idOrName);
}

app.get('/api/v1/agents/:id', readRateLimit, (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent });
});

app.patch('/api/v1/agents/:id', messageRateLimit, async (c) => {
  const body = await c.req.json();
  const parsed = validate(UpdateAgentSchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }

  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const updated = await agentRegistry.update(agent.id, parsed.data);

  if (parsed.data.tools) {
    toolRegistry.bindTools(agent.id, parsed.data.tools);
  }

  return c.json({ agent: updated });
});

app.delete('/api/v1/agents/:id', messageRateLimit, async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  await agentRegistry.delete(agent.id);
  return c.json({ ok: true });
});

// ── SSE Streaming Endpoint ──

app.post('/api/v1/agents/:id/stream', messageRateLimit, async (c) => {
  const body = await c.req.json();
  const parsed = validate(StreamSchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }

  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  return stream(c, async (stream) => {
    // SSE headers
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    try {
      const gen = streamMessage({
        agentId: agent.id,
        text: parsed.data.text,
        sessionId: parsed.data.sessionId,
        channelId: parsed.data.channelId,
      });

      let lastSessionId = '';
      for await (const { sessionId, chunk } of gen) {
        lastSessionId = sessionId;
        if (chunk.type === 'delta') {
          await stream.write(`event: delta\ndata: ${JSON.stringify({ content: chunk.content, sessionId })}\n\n`);
        } else if (chunk.type === 'tool_call') {
          await stream.write(`event: tool_call\ndata: ${JSON.stringify({ toolName: chunk.name, toolCallId: chunk.id, sessionId })}\n\n`);
        }
      }

      await stream.write(`event: done\ndata: ${JSON.stringify({ sessionId: lastSessionId, timestamp: Date.now() })}\n\n`);
    } catch (err) {
      await stream.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }
  });
});

// ── Messages ──

app.post('/api/v1/agents/:id/messages', messageRateLimit, async (c) => {
  const body = await c.req.json();
  const parsed = validate(SendMessageSchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }

  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  try {
    const result = await sendMessage({
      agentId: agent.id,
      sessionId: parsed.data.sessionId,
      text: parsed.data.text,
      channelId: parsed.data.channelId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Message failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get('/api/v1/agents/:id/sessions', readRateLimit, async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const sessions = await sessionManager.listByAgent(agent.id);
  return c.json({ sessions });
});

// ── Tools ──

app.get('/api/v1/tools', readRateLimit, (c) => {
  return c.json({
    tools: toolRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      category: t.category,
    })),
  });
});

// ── Channels ──

app.get('/api/v1/channels', readRateLimit, (c) => {
  return c.json({ channels: channelRouter.listChannels() });
});

app.post('/api/v1/channels/:name/start', messageRateLimit, async (c) => {
  const name = c.req.param('name');
  const ok = await channelRouter.startChannel(name);
  if (!ok) return c.json({ error: `Channel not found: ${name}` }, 404);
  return c.json({ ok: true, channel: name });
});

app.post('/api/v1/channels/:name/stop', messageRateLimit, async (c) => {
  const name = c.req.param('name');
  const ok = await channelRouter.stopChannel(name);
  if (!ok) return c.json({ error: `Channel not found: ${name}` }, 404);
  return c.json({ ok: true, channel: name });
});

// ── Schedules ──

app.post('/api/v1/schedules', messageRateLimit, async (c) => {
  const body = await c.req.json();
  const parsed = validate(CreateScheduleSchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }
  try {
    const job = await scheduleManager.create({
      ...parsed.data,
      payload: JSON.stringify(parsed.data.payload),
    } as any);
    return c.json({ schedule: job }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get('/api/v1/schedules', readRateLimit, (c) => c.json({ schedules: scheduleManager.list() }));

app.get('/api/v1/schedules/:id', readRateLimit, (c) => {
  const job = scheduleManager.get(c.req.param('id'));
  if (!job) return c.json({ error: 'Schedule not found' }, 404);
  return c.json({ schedule: job });
});

app.patch('/api/v1/schedules/:id', messageRateLimit, async (c) => {
  const body = await c.req.json();
  try {
    const updated = await scheduleManager.update(c.req.param('id'), body);
    if (!updated) return c.json({ error: 'Schedule not found' }, 404);
    return c.json({ schedule: updated });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete('/api/v1/schedules/:id', messageRateLimit, async (c) => {
  const ok = await scheduleManager.remove(c.req.param('id'));
  if (!ok) return c.json({ error: 'Schedule not found' }, 404);
  return c.json({ ok: true });
});

app.post('/api/v1/schedules/:id/trigger', messageRateLimit, async (c) => {
  const result = await scheduleManager.trigger(c.req.param('id'));
  if (!result.success) return c.json({ error: result.error }, 404);
  return c.json({ triggered: true });
});

// ── Memory ──

app.get('/api/v1/agents/:id/memory', readRateLimit, (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ memories: memoryManager.load(agent.id) });
});

app.post('/api/v1/agents/:id/memory', messageRateLimit, async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const body = await c.req.json();
  const parsed = validate(SaveMemorySchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }
  const entry = memoryManager.save(agent.id, parsed.data.category as any, parsed.data.key, parsed.data.value);
  return c.json({ memory: entry }, 201);
});

app.post('/api/v1/agents/:id/memory/search', readRateLimit, async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const body = await c.req.json();
  return c.json({ memories: memoryManager.search(agent.id, body.query || '') });
});

app.delete('/api/v1/agents/:id/memory/:key', messageRateLimit, (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const ok = memoryManager.forget(agent.id, c.req.param('key'));
  if (!ok) return c.json({ error: 'Memory not found' }, 404);
  return c.json({ ok: true });
});

// ── Sub-agents ──

app.get('/api/v1/agents/:id/children', readRateLimit, (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ children: listChildren(agent.id) });
});

app.post('/api/v1/agents/:id/spawn', messageRateLimit, async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const body = await c.req.json();
  const parsed = validate(SpawnSchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }
  try {
    const result = await spawnSubAgent({
      parentId: agent.id,
      prompt: parsed.data.prompt,
      ttl: parsed.data.ttl_seconds ? parsed.data.ttl_seconds * 1000 : undefined,
      systemPrompt: parsed.data.systemPrompt,
    });
    return c.json({ result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.delete('/api/v1/agents/:id/children/:childId', messageRateLimit, (c) => {
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
