import type { ToolDefinition, ToolContext, ToolResult } from '../shared/types';
import { logger } from '../shared/logger';

// ── Tool result cache ──

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(toolName: string, params: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(params)}`;
}

function getCached(tool: ToolDefinition, params: Record<string, unknown>): ToolResult | null {
  if (!tool.cacheable) return null;
  const entry = cache.get(cacheKey(tool.name, params));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(tool.name, params));
    return null;
  }
  return entry.result;
}

function setCache(tool: ToolDefinition, params: Record<string, unknown>, result: ToolResult): void {
  if (!tool.cacheable) return;
  cache.set(cacheKey(tool.name, params), {
    result,
    expiresAt: Date.now() + (tool.cacheTtlMs ?? 60_000),
  });
}

// ── Single tool execution ──

export async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  ctx: Partial<ToolContext> & { agentId: string; sessionId: string },
): Promise<ToolResult> {
  // Check cache first
  const cached = getCached(tool, params);
  if (cached) {
    logger.debug({ tool: tool.name }, 'Tool cache hit');
    return cached;
  }

  const timeout = tool.timeoutMs ?? 30_000;
  const maxBytes = tool.maxOutputBytes ?? 1_000_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Link parent signal if provided
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      clearTimeout(timer);
      return { content: '', error: 'Parent signal already aborted' };
    }
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const fullCtx: ToolContext = {
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      signal: controller.signal,
    };

    const startMs = Date.now();
    const result = await tool.execute(params, fullCtx);
    const durationMs = Date.now() - startMs;

    if (result.content.length > maxBytes) {
      result.content = result.content.slice(0, maxBytes) + '\n[TRUNCATED]';
    }

    logger.info({ tool: tool.name, durationMs, cached: false }, 'Tool executed');
    setCache(tool, params, result);
    return result;
  } catch (err) {
    const error = err as Error;
    if (error.name === 'AbortError') {
      return { content: '', error: `Tool timed out after ${timeout}ms` };
    }
    logger.error({ tool: tool.name, error: error.message }, 'Tool execution failed');
    return { content: '', error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Parallel tool execution ──

export interface ParallelToolCall {
  tool: ToolDefinition;
  params: Record<string, unknown>;
}

export async function executeToolsParallel(
  calls: ParallelToolCall[],
  ctx: Partial<ToolContext> & { agentId: string; sessionId: string },
): Promise<ToolResult[]> {
  if (calls.length === 0) return [];

  // Execute all in parallel — each tool gets its own AbortController
  const results = await Promise.all(
    calls.map((call) => executeTool(call.tool, call.params, ctx)),
  );

  return results;
}

// ── Cache management ──

export function clearToolCache(toolName?: string): void {
  if (!toolName) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${toolName}:`)) cache.delete(key);
  }
}
