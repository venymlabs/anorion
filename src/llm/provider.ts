// LLM Provider — unified interface using multi-provider registry

import { generateText, streamText, type ModelMessage, type Tool as AiTool } from 'ai';
import { jsonSchema } from '@ai-sdk/provider-utils';
import { resolveModel, type ResolvedModel } from './providers';
import { logger } from '../shared/logger';
import { eventBus } from '../shared/events';
import type { ToolDefinition } from '../shared/types';
import { tokenBudget } from '../shared/token-budget';

export interface LlmOptions {
  systemPrompt: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  modelId: string;
  fallbackModelId?: string;
  maxTokens?: number;
  temperature?: number;
}

// ── Retry with exponential backoff + jitter ──

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
};

async function withRetry<T>(fn: () => Promise<T>, retry: Partial<RetryConfig> = {}): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...retry };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < cfg.maxRetries) {
        const delay = Math.min(cfg.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000, cfg.maxDelayMs);
        logger.warn({ attempt: attempt + 1, delay: Math.round(delay), error: lastError.message }, 'LLM call failed, retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

// ── Circuit Breaker ──

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60_000;

function checkCircuit(modelId: string): void {
  const state = circuits.get(modelId);
  if (!state || !state.open) return;
  if (Date.now() - state.lastFailure > CIRCUIT_RESET_MS) {
    state.open = false;
    state.failures = 0;
    logger.info({ modelId }, 'Circuit breaker reset');
    return;
  }
  throw new Error(`Circuit breaker open for ${modelId} — too many failures`);
}

function recordFailure(modelId: string): void {
  if (!circuits.has(modelId)) circuits.set(modelId, { failures: 0, lastFailure: 0, open: false });
  const state = circuits.get(modelId)!;
  state.failures++;
  state.lastFailure = Date.now();
  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.open = true;
    logger.warn({ modelId, failures: state.failures }, 'Circuit breaker opened');
  }
}

function recordSuccess(modelId: string): void {
  const state = circuits.get(modelId);
  if (state) { state.failures = 0; state.open = false; }
}

// ── Main LLM Interface ──

export async function callLlm(options: LlmOptions): Promise<{
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const { modelId, fallbackModelId, tools, systemPrompt, messages, maxTokens, temperature } = options;

  const aiTools: Record<string, AiTool> = {};
  for (const tool of tools) {
    aiTools[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters as Record<string, unknown>),
      execute: undefined as unknown as AiTool['execute'],
    };
  }

  const models = [modelId, ...(fallbackModelId ? [fallbackModelId] : [])];
  let lastError: Error | null = null;

  for (const mid of models) {
    try {
      checkCircuit(mid);
      const resolved = resolveModel(mid);

      // Token budget check (estimate ~4 chars per token for check)
      const estimatedTokens = Math.ceil(
        (systemPrompt.length + JSON.stringify(messages).length) / 4 + (maxTokens || 4096)
      );
      const budget = tokenBudget.canSpend('global', 'llm-call', estimatedTokens);
      if (!budget.allowed) {
        throw new Error(`Token budget: ${budget.reason}`);
      }

      logger.debug({ model: mid, provider: resolved.providerName, toolCount: Object.keys(aiTools).length }, 'Calling LLM');

      const result = await withRetry(() => generateText({
        model: resolved.instance,
        system: systemPrompt,
        messages,
        tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
        maxOutputTokens: maxTokens,
        temperature,
      }));

      recordSuccess(mid);

      // Emit token usage event
      const usageInputTokens = result.usage?.inputTokens ?? 0;
      const usageOutputTokens = result.usage?.outputTokens ?? 0;
      if (result.usage) {
        eventBus.emit('token:usage', {
          agentId: 'global',
          sessionId: 'llm-call',
          model: mid,
          promptTokens: usageInputTokens,
          completionTokens: usageOutputTokens,
          timestamp: Date.now(),
        });
      }

      const toolCalls = result.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        arguments: JSON.stringify('input' in tc ? tc.input : {}),
      }));

      return {
        content: result.text,
        toolCalls,
        usage: result.usage ? {
          promptTokens: usageInputTokens,
          completionTokens: usageOutputTokens,
          totalTokens: usageInputTokens + usageOutputTokens,
        } : undefined,
      };
    } catch (err) {
      lastError = err as Error;
      recordFailure(mid);
      logger.warn({ model: mid, error: lastError.message }, 'LLM call failed');
    }
  }

  throw lastError || new Error('All LLM providers failed');
}

export async function* streamLlm(options: LlmOptions) {
  const { modelId, tools, systemPrompt, messages, maxTokens, temperature } = options;

  const aiTools: Record<string, AiTool> = {};
  for (const tool of tools) {
    aiTools[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters as Record<string, unknown>),
      execute: undefined as unknown as AiTool['execute'],
    };
  }

  const resolved = resolveModel(modelId);
  checkCircuit(modelId);

  const result = streamText({
    model: resolved.instance,
    system: systemPrompt,
    messages,
    tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
    maxOutputTokens: maxTokens,
    temperature,
  });

  let totalInput = 0;
  let totalOutput = 0;

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case 'text-delta':
        totalOutput += chunk.text.length;
        yield { type: 'delta' as const, content: chunk.text };
        break;
      case 'tool-call':
        yield {
          type: 'tool_call' as const,
          id: chunk.toolCallId,
          name: chunk.toolName,
          arguments: 'input' in chunk ? chunk.input : {},
        };
        break;
      case 'finish': {
        const usage = chunk.totalUsage;
        const pTokens = usage.inputTokens ?? 0;
        const cTokens = usage.outputTokens ?? 0;
        totalInput = pTokens;
        totalOutput = cTokens;
        eventBus.emit('token:usage', {
          agentId: 'global',
          sessionId: 'llm-stream',
          model: modelId,
          promptTokens: totalInput,
          completionTokens: totalOutput,
          timestamp: Date.now(),
        });
        yield { type: 'done' as const, usage: { promptTokens: pTokens, completionTokens: cTokens, totalTokens: pTokens + cTokens } };
        recordSuccess(modelId);
        break;
      }
    }
  }
}

export type StreamChunk =
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
