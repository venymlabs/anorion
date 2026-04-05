// Observability routes — traces, metrics, detailed health

import { Hono } from 'hono';
import { authMiddleware, requireScope } from '../auth/middleware';
import { queryTraces, getTrace, type RequestTrace } from './tracer';
import { metricsCollector } from './metrics';

const app = new Hono();

// ── Traces ──

app.get('/api/v1/traces', authMiddleware, requireScope('read'), (c) => {
  const traces = queryTraces({
    agentId: c.req.query('agentId'),
    sessionId: c.req.query('sessionId'),
    since: c.req.query('since') ? Number(c.req.query('since')) : undefined,
    limit: Number(c.req.query('limit')) || 100,
  });

  return c.json({
    traces: traces.map((t) => ({
      traceId: t.traceId,
      spanId: t.spanId,
      method: t.method,
      path: t.path,
      statusCode: t.statusCode,
      durationMs: t.durationMs,
      userId: t.userId,
      agentId: t.agentId,
      startTime: t.startTime,
      error: t.error,
    })),
    count: traces.length,
  });
});

app.get('/api/v1/traces/:traceId', authMiddleware, requireScope('read'), (c) => {
  const trace = getTrace(c.req.param('traceId')!);
  if (!trace) return c.json({ error: 'Trace not found' }, 404);
  return c.json({ trace });
});

// ── Metrics ──

app.get('/api/v1/metrics', authMiddleware, requireScope('read'), (c) => {
  const since = c.req.query('since') ? Number(c.req.query('since')) : undefined;
  const agentId = c.req.query('agentId') || undefined;

  return c.json({
    latency: metricsCollector.getLatencyHistogram(since, agentId),
    tokens: metricsCollector.getTokenUsage(since, agentId),
    errors: metricsCollector.getErrorRate(since),
  });
});

// ── Detailed health with observability ──
app.get('/api/v1/health/observability', authMiddleware, (c) => {
  const mem = process.memoryUsage();
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    nodeVersion: process.version,
    pid: process.pid,
    recentLatency: metricsCollector.getLatencyHistogram(Date.now() - 300_000), // last 5 min
    recentErrors: metricsCollector.getErrorRate(Date.now() - 300_000),
  });
});

export default app;
