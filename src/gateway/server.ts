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
import { authMiddleware, rateLimitPerKey } from '../auth/middleware';
import { extractTraceContext, generateSpanId, storeTrace, type RequestTrace } from '../observability/tracer';
import { metricsCollector } from '../observability/metrics';
import { searchEngine } from '../search/engine';
import { configVersioning } from '../config/versioning';
import { setPreparedForMessages } from './routes-messages';
import { UPLOAD_DIR } from './routes-upload';
import { setWsAuth } from './ws';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

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

// ── CORS (configurable origins) ──
let corsOrigins: string | string[] = '*';

export function setCorsOrigins(origins: string | string[]) {
  corsOrigins = origins;
}

app.use('*', cors({
  origin: corsOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400,
}));

// ── Tracing middleware — wraps every request with a trace ──
app.use('*', async (c, next) => {
  const { traceId, parentSpanId } = extractTraceContext(c);
  const spanId = generateSpanId();

  const trace: RequestTrace = {
    traceId,
    parentSpanId,
    spanId,
    startTime: Date.now(),
    method: c.req.method,
    path: c.req.path,
  };

  c.set('trace', trace);

  // Propagate trace ID in response headers
  c.header('X-Trace-Id', traceId);

  // Rate limit response headers (informational)
  c.header('X-RateLimit-Limit', '120');
  c.header('X-RateLimit-Remaining', '119');
  c.header('X-RateLimit-Reset', String(Math.ceil((Date.now() + 60000) / 1000)));

  const startMs = performance.now();
  try {
    await next();
  } catch (err) {
    trace.error = (err as Error).message;
    metricsCollector.recordError(c.req.path, 500, (err as Error).message);
    throw err;
  } finally {
    const durationMs = Math.round(performance.now() - startMs);
    trace.endTime = Date.now();
    trace.durationMs = durationMs;
    trace.statusCode = c.res?.status;

    // Store trace (skip high-frequency health checks)
    if (c.req.path !== '/health' && c.req.path !== '/api/v1/health') {
      storeTrace(trace);
      metricsCollector.recordLatency(durationMs, c.req.path);
    }
  }
});

// ── Auth Middleware (applied globally) ──
app.use('*', authMiddleware);

// ── Rate limiting (applied per-key after auth) ──
app.use('/api/v1/agents/*', rateLimitPerKey());
app.use('/api/v1/schedules/*', rateLimitPerKey());
app.use('/api/v1/memory/*', rateLimitPerKey());

// ── Health ──
app.get('/health', (c) => c.json({
  status: 'ok',
  uptime: process.uptime(),
  timestamp: new Date().toISOString(),
  agents: agentRegistry.list().length,
}));

// ── Agents ──

app.get('/api/v1/agents', (c) => {
  return c.json({ agents: agentRegistry.list() });
});

app.post('/api/v1/agents', async (c) => {
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

app.get('/api/v1/agents/:id', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent });
});

app.patch('/api/v1/agents/:id', async (c) => {
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

app.delete('/api/v1/agents/:id', async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  await agentRegistry.delete(agent.id);
  return c.json({ ok: true });
});

// ── SSE Streaming Endpoint ──

app.post('/api/v1/agents/:id/stream', async (c) => {
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

app.post('/api/v1/agents/:id/messages', async (c) => {
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

app.get('/api/v1/agents/:id/sessions', async (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const sessions = await sessionManager.listByAgent(agent.id);
  return c.json({ sessions });
});

// ── Tools ──

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

// ── Channels ──

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
  const parsed = validate(SaveMemorySchema, body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', fields: parsed.error.fieldErrors }, 400);
  }
  const entry = memoryManager.save(agent.id, parsed.data.category as any, parsed.data.key, parsed.data.value);
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

app.delete('/api/v1/agents/:id/children/:childId', (c) => {
  const agent = resolveAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const ok = killChild(agent.id, c.req.param('childId'));
  if (!ok) return c.json({ error: 'Child not found' }, 404);
  return c.json({ ok: true });
});

// ── Config Versioning ──

app.get('/api/v1/config/history', (c) => {
  const snapshots = configVersioning.list(Number(c.req.query('limit')) || 50);
  return c.json({ snapshots });
});

app.get('/api/v1/config/history/:id', (c) => {
  const snapshot = configVersioning.get(c.req.param('id'));
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  return c.json({ snapshot });
});

app.post('/api/v1/config/snapshot', (c) => {
  const id = configVersioning.save(c.req.query('reason') || undefined);
  return c.json({ id }, 201);
});

app.post('/api/v1/config/rollback/:id', (c) => {
  const snapshot = configVersioning.rollback(c.req.param('id'));
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  return c.json({ snapshot, ok: true });
});

// ── Static file serving for uploads ──
app.get('/uploads/*', async (c) => {
  const filePath = resolve(UPLOAD_DIR, c.req.path.replace('/uploads/', ''));
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return c.json({ error: 'File not found' }, 404);
  }
  return new Response(file);
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

// ── Register Auth & Observability sub-routers ──

import authRoutes from '../auth/routes';
import observabilityRoutes from '../observability/routes';
import routesV2 from './routes-v2';
import routesMessages from './routes-messages';
import routesSearch from './routes-search';
import routesUpload from './routes-upload';

app.route('/', authRoutes);
app.route('/', observabilityRoutes);
app.route('/', routesV2);
app.route('/', routesMessages);
app.route('/', routesSearch);
app.route('/', routesUpload);

/** Initialize gateway sub-systems (upload dir). DB wiring is done via setGatewayDb. */
export function initGatewayModules() {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/** Wire up prepared statements to all sub-systems. */
export function setGatewayDb(
  prepared: import('../shared/db/prepared').PreparedStatements,
  rawDb: import('bun:sqlite').Database,
  configPath?: string,
) {
  setPreparedForMessages(prepared);
  searchEngine.setPrepared(prepared);
  searchEngine.setRawDb(rawDb);
  configVersioning.init(prepared, configPath || '');
}

export default app;
export type AppType = typeof app;
