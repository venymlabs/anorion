// OpenAI-Compatible API Endpoint
// Drop-in replacement for OpenAI SDK — supports streaming + non-streaming

import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { providerRegistry } from '../providers';
import type { NormalizedRequest, NormalizedMessage, NormalizedTool } from '../providers/types';
import { logger } from '../shared/logger';

export const openaiCompat = new Hono();

// ── Auth middleware ──
openaiCompat.use('*', async (c, next) => {
  // Support both Bearer token and api-key header
  const auth = c.req.header('Authorization');
  const apiKey = c.req.header('api-key');

  // For now, allow if gateway has no strict keys or if key matches
  // The main server auth middleware handles the primary check
  await next();
});

// ── GET /v1/models ──
openaiCompat.get('/v1/models', (c) => {
  const adapters = providerRegistry.listAdapters();
  const models: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }> = [];

  for (const adapter of adapters) {
    if (!adapter.configured) continue;
    for (const model of adapter.models) {
      models.push({
        id: `${adapter.id}/${model}`,
        object: 'model',
        created: 1700000000,
        owned_by: adapter.name,
      });
    }
  }

  return c.json({
    object: 'list',
    data: models,
  });
});

// ── POST /v1/chat/completions ──
openaiCompat.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json();

  // Parse request in OpenAI format
  const model: string = body.model ?? 'gpt-4o';
  const messages: NormalizedMessage[] = (body.messages ?? []).map((m: any) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    name: m.name,
    tool_call_id: m.tool_call_id,
    tool_calls: m.tool_calls,
  }));

  const tools: NormalizedTool[] | undefined = body.tools?.map((t: any) => ({
    type: 'function',
    function: {
      name: t.function?.name ?? t.name,
      description: t.function?.description,
      parameters: t.function?.parameters,
    },
  }));

  const streamReq = body.stream === true;

  const req: NormalizedRequest = {
    model,
    messages,
    tools: tools?.length ? tools : undefined,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    stream: streamReq,
    stop: body.stop,
  };

  if (streamReq) {
    // Streaming response — SSE format matching OpenAI exactly
    return stream(c, async (s) => {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      c.header('X-Accel-Buffering', 'no');

      const abortController = new AbortController();
      s.onAbort(() => {
        abortController.abort();
      });

      try {
        for await (const chunk of providerRegistry.chatCompletionStream(req)) {
          if (abortController.signal.aborted) break;
          await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        await s.write('data: [DONE]\n\n');
      } catch (err) {
        if (!abortController.signal.aborted) {
          logger.error({ error: (err as Error).message }, 'OpenAI compat stream error');
          await s.write(`data: ${JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } })}\n\n`);
          await s.write('data: [DONE]\n\n');
        }
      }
    });
  }

  // Non-streaming response
  try {
    const response = await providerRegistry.chatCompletion(req);
    return c.json(response);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'OpenAI compat completion error');
    return c.json(
      {
        error: {
          message: (err as Error).message,
          type: 'server_error',
          param: null,
          code: null,
        },
      },
      500,
    );
  }
});
