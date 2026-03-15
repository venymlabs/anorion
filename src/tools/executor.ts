import type { ToolDefinition, ToolContext, ToolResult } from '../shared/types';
import { logger } from '../shared/logger';

export async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  ctx: Partial<ToolContext> & { agentId: string; sessionId: string },
): Promise<ToolResult> {
  const timeout = tool.timeoutMs ?? 30000;
  const maxBytes = tool.maxOutputBytes ?? 1_000_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const fullCtx: ToolContext = {
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      signal: ctx.signal ?? controller.signal,
    };

    logger.debug({ tool: tool.name }, 'Executing tool');
    const result = await tool.execute(params, fullCtx);

    if (result.content.length > maxBytes) {
      result.content = result.content.slice(0, maxBytes) + '\n[TRUNCATED]';
    }

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
