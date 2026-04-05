// AI SDK Adapter — wraps Vercel AI SDK v6 to implement ProviderAdapter
// This single adapter handles all providers since AI SDK supports them all

import type {
  ProviderAdapter,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedMessage,
  StreamChunkDelta,
} from '../types';
import { generateText, streamText, type ModelMessage } from 'ai';
import { resolveModel, PROVIDERS, type ProviderDef } from '../../llm/providers';
import { eventBus } from '../../shared/events';
import { logger } from '../../shared/logger';

function toModelMessages(msgs: NormalizedMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'tool') {
      result.push({
        role: 'tool' as const,
        content: m.content,
        toolCallId: m.tool_call_id ?? '',
      } as unknown as ModelMessage);
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      result.push({
        role: 'assistant' as const,
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((tc) => ({
          type: 'function' as const,
          id: tc.id,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      } as unknown as ModelMessage);
    } else {
      result.push({ role: m.role, content: m.content } as unknown as ModelMessage);
    }
  }
  return result;
}

export class AiSdkAdapter implements ProviderAdapter {
  constructor(
    public readonly id: string,
    public readonly name: string,
    private providerDef: ProviderDef,
  ) {}

  validateConfig(): boolean {
    return !!process.env[this.providerDef.envKey];
  }

  listModels(): string[] {
    return this.providerDef.popularModels;
  }

  async chatCompletion(req: NormalizedRequest): Promise<NormalizedResponse> {
    const fullModelStr = `${this.id}/${req.model}`;
    const resolved = resolveModel(fullModelStr);

    const systemMsg = req.messages.find((m) => m.role === 'system');
    const nonSystemMsgs = req.messages.filter((m) => m.role !== 'system');

    const aiTools = req.tools?.length
      ? Object.fromEntries(
          req.tools.map((t) => [
            t.function.name,
            {
              description: t.function.description,
              parameters: t.function.parameters as Record<string, unknown>,
            },
          ]),
        )
      : undefined;

    const result = await generateText({
      model: resolved.instance,
      system: systemMsg?.content,
      messages: toModelMessages(nonSystemMsgs),
      tools: aiTools as any,
      maxOutputTokens: req.max_tokens,
      temperature: req.temperature,
    });

    const usage = result.totalUsage;
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens = usage.outputTokens ?? 0;

    eventBus.emit('token:usage', {
      agentId: 'openai-compat',
      sessionId: 'chat-completion',
      model: fullModelStr,
      promptTokens,
      completionTokens,
      timestamp: Date.now(),
    });

    const toolCalls = result.toolCalls.map((tc: any) => ({
      id: tc.toolCallId,
      type: 'function' as const,
      function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? tc.args) },
    }));

    return {
      id: `chatcmpl-${crypto.randomUUID().slice(0, 24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : result.finishReason === 'length' ? 'length' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  async *chatCompletionStream(req: NormalizedRequest): AsyncIterable<StreamChunkDelta> {
    const fullModelStr = `${this.id}/${req.model}`;
    const resolved = resolveModel(fullModelStr);

    const systemMsg = req.messages.find((m) => m.role === 'system');
    const nonSystemMsgs = req.messages.filter((m) => m.role !== 'system');

    const aiTools = req.tools?.length
      ? Object.fromEntries(
          req.tools.map((t) => [
            t.function.name,
            {
              description: t.function.description,
              parameters: t.function.parameters as Record<string, unknown>,
            },
          ]),
        )
      : undefined;

    const chatId = `chatcmpl-${crypto.randomUUID().slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    let tcIndex = 0;

    const result = streamText({
      model: resolved.instance,
      system: systemMsg?.content,
      messages: toModelMessages(nonSystemMsgs),
      tools: aiTools as any,
      maxOutputTokens: req.max_tokens,
      temperature: req.temperature,
    });

    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        case 'text-delta':
          yield {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: req.model,
            choices: [
              {
                index: 0,
                delta: { content: (chunk as any).text ?? '' },
                finish_reason: null,
              },
            ],
          };
          break;
        case 'tool-call': {
          const idx = tcIndex++;
          const args = JSON.stringify((chunk as any).input ?? (chunk as any).args);
          yield {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: req.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: (chunk as any).toolCallId,
                      type: 'function',
                      function: { name: (chunk as any).toolName, arguments: args },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
          break;
        }
        case 'finish': {
          const finishChunk = chunk as any;
          const promptTokens = finishChunk.totalUsage?.inputTokens ?? 0;
          const completionTokens = finishChunk.totalUsage?.outputTokens ?? 0;

          if (promptTokens || completionTokens) {
            eventBus.emit('token:usage', {
              agentId: 'openai-compat',
              sessionId: 'stream',
              model: fullModelStr,
              promptTokens,
              completionTokens,
              timestamp: Date.now(),
            });
          }

          yield {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: req.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finishChunk.finishReason === 'tool-calls' ? 'tool_calls' : finishChunk.finishReason === 'length' ? 'length' : 'stop',
              },
            ],
          };
          break;
        }
      }
    }
  }
}
