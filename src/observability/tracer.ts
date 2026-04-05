// Per-request tracing — trace ID generation, context propagation

import type { Context } from 'hono';
import { randomUUID } from 'crypto';

export interface RequestTrace {
  traceId: string;
  parentSpanId?: string;
  spanId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  method: string;
  path: string;
  statusCode?: number;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  model?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export function generateTraceId(): string {
  return `tr_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function generateSpanId(): string {
  return `sp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Extract or create trace context from request headers */
export function extractTraceContext(c: Context): { traceId: string; parentSpanId?: string } {
  const traceId = c.req.header('X-Trace-Id') || generateTraceId();
  const parentSpanId = c.req.header('X-Span-Id') || undefined;
  return { traceId, parentSpanId };
}

declare module 'hono' {
  interface ContextVariableMap {
    trace: RequestTrace;
  }
}

// In-memory trace store (capped at 10k entries)
const MAX_TRACES = 10_000;
const traceStore: RequestTrace[] = [];

export function storeTrace(trace: RequestTrace): void {
  traceStore.push(trace);
  if (traceStore.length > MAX_TRACES) {
    traceStore.splice(0, traceStore.length - MAX_TRACES);
  }
}

export function queryTraces(filters: {
  traceId?: string;
  agentId?: string;
  sessionId?: string;
  since?: number;
  limit?: number;
}): RequestTrace[] {
  let results = [...traceStore];

  if (filters.traceId) {
    results = results.filter((t) => t.traceId === filters.traceId);
    return results;
  }

  if (filters.agentId) {
    results = results.filter((t) => t.agentId === filters.agentId);
  }
  if (filters.sessionId) {
    results = results.filter((t) => t.sessionId === filters.sessionId);
  }
  if (filters.since) {
    results = results.filter((t) => t.startTime >= filters.since!);
  }

  results.sort((a, b) => b.startTime - a.startTime);
  return results.slice(0, filters.limit || 100);
}

export function getTrace(traceId: string): RequestTrace | undefined {
  return traceStore.find((t) => t.traceId === traceId);
}
