import { generateText, streamText, type CoreMessage, type Tool as AiTool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { logger } from '../shared/logger';
import type { ToolDefinition } from '../shared/types';

function getModel(modelId: string) {
  const [provider, ...rest] = modelId.split('/');
  const modelName = rest.join('/') || modelId;

  switch (provider) {
    case 'openai':
      return openai(modelName);
    case 'anthropic':
    case 'claude':
      return anthropic(modelName);
    default:
      // Default to openai-compatible
      return openai(modelName);
  }
}

export interface LlmOptions {
  systemPrompt: string;
  messages: CoreMessage[];
  tools: ToolDefinition[];
  modelId: string;
  fallbackModelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function callLlm(options: LlmOptions): Promise<{
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const { modelId, fallbackModelId, tools, ...rest } = options;

  const aiTools: Record<string, AiTool> = {};
  for (const tool of tools) {
    aiTools[tool.name] = {
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      execute: undefined as unknown as AiTool['execute'], // We handle execution ourselves
    };
  }

  const models = [modelId, ...(fallbackModelId ? [fallbackModelId] : [])];

  let lastError: Error | null = null;

  for (const model of models) {
    try {
      logger.debug({ model, toolCount: Object.keys(aiTools).length }, 'Calling LLM');

      const result = await generateText({
        model: getModel(model),
        system: rest.systemPrompt,
        messages: rest.messages,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
        maxTokens: rest.maxTokens,
        temperature: rest.temperature,
      });

      const toolCalls = result.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        arguments: JSON.stringify(tc.args),
      }));

      return {
        content: result.text,
        toolCalls,
        usage: result.usage ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.promptTokens + result.usage.completionTokens,
        } : undefined,
      };
    } catch (err) {
      lastError = err as Error;
      logger.warn({ model, error: (err as Error).message }, 'LLM call failed, trying fallback');
    }
  }

  throw lastError || new Error('All LLM providers failed');
}

export async function* streamLlm(options: LlmOptions) {
  const { modelId, tools, ...rest } = options;

  const aiTools: Record<string, AiTool> = {};
  for (const tool of tools) {
    aiTools[tool.name] = {
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      execute: undefined as unknown as AiTool['execute'],
    };
  }

  const result = streamText({
    model: getModel(modelId),
    system: rest.systemPrompt,
    messages: rest.messages,
    tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
    maxTokens: rest.maxTokens,
    temperature: rest.temperature,
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case 'text-delta':
        yield { type: 'delta' as const, content: chunk.textDelta };
        break;
      case 'tool-call':
        yield {
          type: 'tool_call' as const,
          id: chunk.toolCallId,
          name: chunk.toolName,
          arguments: chunk.args,
        };
        break;
      case 'finish':
        yield { type: 'done' as const, usage: chunk.usage };
        break;
    }
  }
}

export type StreamChunk =
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
