import {
  generateText,
  streamText,
  type ModelMessage,
  type Tool as AiTool,
} from 'ai';
import type {
  Agent,
  ToolCall,
  ToolResultEntry,
  StreamChunk,
  OnChunkCallback,
  CategorizedError,
  AgentRunMetrics,
} from '../shared/types';
import { toolRegistry } from '../tools/registry';
import { executeTool, executeToolsParallel, type ParallelToolCall } from '../tools/executor';
import { sessionManager } from './session';
import { agentRegistry } from './registry';
import { shouldCompact, compactMessages } from '../memory/context';
import { logger } from '../shared/logger';
import { memoryManager } from '../memory/store';
import { eventBus } from '../shared/events';
import { resolveModel } from '../llm/providers';
import { jsonSchema } from '@ai-sdk/provider-utils';
import { registerHandoffTools, getHandoffToolNames } from './handoff';
import type { AgentHandoffConfig } from '../shared/types';

// ── Interfaces ──

export interface SendMessageInput {
  agentId: string;
  sessionId?: string;
  text: string;
  channelId?: string;
  stream?: boolean;
  abortSignal?: AbortSignal;
  onChunk?: OnChunkCallback;
  maxIterations?: number;
}

export interface SendMessageResult {
  sessionId: string;
  content: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultEntry[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
  iterations: number;
  metrics?: AgentRunMetrics;
}

// ── Error categorization ──

function categorizeError(err: Error): CategorizedError {
  const msg = err.message.toLowerCase();
  const statusMatch = msg.match(/status[_ ]?(\d{3})/);
  const status = statusMatch?.[1] ? parseInt(statusMatch[1]) : 0;

  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    const retryAfter = msg.match(/retry[_-]?after[:\s]+(\d+)/);
    return {
      category: 'rate_limit',
      message: err.message,
      retryable: true,
      retryAfterMs: retryAfter?.[1] ? parseInt(retryAfter[1]) * 1000 : 2000,
      originalError: err,
    };
  }

  if (status === 401 || status === 403 || msg.includes('auth') || msg.includes('api key') || msg.includes('forbidden')) {
    return { category: 'authentication', message: err.message, retryable: false, originalError: err };
  }

  if (err.name === 'AbortError' || msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
    return { category: 'timeout', message: err.message, retryable: true, retryAfterMs: 1000, originalError: err };
  }

  if (status === 400 && (msg.includes('context') || msg.includes('token') || msg.includes('max'))) {
    return { category: 'context_length', message: err.message, retryable: false, originalError: err };
  }

  if (status >= 500 || msg.includes('overloaded') || msg.includes('server error')) {
    return { category: 'model_error', message: err.message, retryable: true, retryAfterMs: 3000, originalError: err };
  }

  return { category: 'unknown', message: err.message, retryable: false, originalError: err };
}

// ── Retry with error-aware backoff ──

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
): Promise<T> {
  let lastErr: CategorizedError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = categorizeError(err as Error);

      if (!lastErr.retryable || attempt >= maxRetries) {
        throw lastErr.originalError;
      }

      const delay = lastErr.retryAfterMs
        ? lastErr.retryAfterMs * Math.pow(2, attempt)
        : 1000 * Math.pow(2, attempt);

      const jitter = Math.random() * 500;
      const waitMs = Math.min(delay + jitter, 30_000);

      logger.warn(
        { category: lastErr.category, attempt: attempt + 1, waitMs: Math.round(waitMs), error: lastErr.message },
        'LLM call failed, retrying',
      );

      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastErr!.originalError;
}

// ── Build AI SDK tools (v6 compatible) ──

function buildAiTools(
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Record<string, AiTool> {
  const tools = toolRegistry.listForAgent(agentId);
  const aiTools: Record<string, AiTool> = {};

  for (const t of tools) {
    aiTools[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.parameters as any),
      execute: async (args: Record<string, unknown>, { }: { toolCallId: string }) => {
        if (signal?.aborted) return { error: 'Aborted' };
        try {
          const result = await executeTool(t, args, { agentId, sessionId, signal });
          if (result.error) {
            return { error: result.error, content: result.content };
          }
          return result.content;
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    } as AiTool;
  }

  return aiTools;
}

// ── Helper to extract tool call info from v6 TypedToolCall ──

function extractToolCallInfo(tc: { toolCallId: string; toolName: string; input: unknown }): ToolCall {
  return {
    id: tc.toolCallId,
    name: tc.toolName,
    arguments: JSON.stringify(tc.input),
  };
}

function extractUsage(usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const p = usage?.inputTokens ?? 0;
  const c = usage?.outputTokens ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: p + c };
}

// ── Main sendMessage with proper agentic loop ──

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const agent = agentRegistry.get(input.agentId) || agentRegistry.getByName(input.agentId);
  if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
  const agentId = agent.id;

  agentRegistry.setState(agentId, 'processing');

  // Register handoff tools if agent has handoffs configured
  if (agent.handoffs && agent.handoffs.length > 0) {
    registerHandoffTools(agentId, agent.handoffs.map((h: AgentHandoffConfig) => ({
      targetAgentId: h.targetAgentId,
      description: h.description,
    })));
  }

  const abortController = new AbortController();
  const signal = input.abortSignal ?? abortController.signal;

  // Link external abort signal
  if (input.abortSignal) {
    input.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  try {
    // Get or create session
    let sessionId = input.sessionId ?? '';
    if (!sessionId) {
      const session = await sessionManager.create(agentId, input.channelId);
      sessionId = session.id;
    }

    eventBus.emit('agent:processing', { agentId, sessionId, timestamp: Date.now() });

    // Store user message
    await sessionManager.addMessage({
      sessionId,
      agentId,
      role: 'user',
      content: input.text,
      priority: 'high',
    });

    const startTime = Date.now();
    const onChunk = input.onChunk;

    // Build context from history
    const history = await sessionManager.getMessagesAsCore(sessionId, 50);
    let contextMessages: ModelMessage[] = history;
    if (shouldCompact(history as any[])) {
      const { messages: compacted } = compactMessages(history as any[]);
      contextMessages = compacted as ModelMessage[];
      logger.info({ sessionId }, 'Context compacted before inference');
    }

    // Ensure at least one user message
    if (!contextMessages.some((m) => m.role === 'user')) {
      contextMessages.push({ role: 'user', content: input.text });
    }

    const memoryContext = memoryManager.buildContext(agent.id);
    const systemPrompt = memoryContext
      ? `${agent.systemPrompt}\n\n${memoryContext}`
      : agent.systemPrompt;

    const maxIter = input.maxIterations || agent.maxIterations || 10;
    const resolved = resolveModel(agent.model);

    // Track metrics
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResultEntry[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let iterations = 0;
    let finalContent = '';

    // ── Agentic loop ──
    // We use a simple approach: call generateText with stopWhen: stepCountIs(maxIter)
    // but with our own onStepFinish for parallel tool execution tracking.
    // AI SDK v6 handles the multi-turn loop internally with stepCountIs.

    const aiTools = buildAiTools(agent.id, sessionId, signal);
    const hasTools = Object.keys(aiTools).length > 0;

    try {
      const agentId = agent.id;
      const agentName = agent.name;
      const result = await retryWithBackoff(() =>
        generateText({
          model: resolved.instance,
          system: systemPrompt,
          messages: contextMessages,
          tools: hasTools ? aiTools : undefined,
          stopWhen: hasTools ? stepCountIs(maxIter) : stepCountIs(1),
          maxOutputTokens: 4096,
          temperature: 0.7,
          abortSignal: signal,
          onStepFinish: (step) => {
            // Track tool calls and results
            for (const tc of step.toolCalls as any[]) {
              const call = extractToolCallInfo(tc);
              allToolCalls.push(call);
              eventBus.emit('agent:tool-call', {
                agentId: agent.id,
                sessionId,
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                timestamp: Date.now(),
              });
              if (onChunk) {
                onChunk({ type: 'tool_call', toolCall: call });
              }
            }
            for (const tr of step.toolResults as any[]) {
              const entry: ToolResultEntry = {
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
              };
              allToolResults.push(entry);
              if (onChunk) {
                onChunk({ type: 'tool_result', toolResult: entry });
              }
            }
            // Accumulate usage per step
            if (step.usage) {
              const u = extractUsage(step.usage);
              totalPromptTokens += u.promptTokens;
              totalCompletionTokens += u.completionTokens;
            }
            // Stream text from each step
            if (step.text && onChunk) {
              onChunk({ type: 'delta', content: step.text });
            }
          },
        }),
      );

      // Final usage from result
      if (result.usage) {
        const u = extractUsage(result.usage as any);
        // Use the final result usage as the most accurate
        totalPromptTokens = u.promptTokens || totalPromptTokens;
        totalCompletionTokens = u.completionTokens || totalCompletionTokens;
      }

      finalContent = result.text || '';
      iterations = allToolCalls.length > 0 ? maxIter : 1; // approximate

      // Stream final text
      if (finalContent && onChunk) {
        // Already streamed via onStepFinish, but ensure final is captured
      }

    } catch (err) {
      const cat = categorizeError(err as Error);

      // If context_length error, try compacting and retrying once
      if (cat.category === 'context_length') {
        logger.info({ sessionId }, 'Context length exceeded, forcing compaction');
        const { messages: compacted } = compactMessages(history as any[], {
          thresholdPercent: 0.5,
          keepLastMessages: 10,
        });
        contextMessages = compacted as ModelMessage[];

        const retryResult = await generateText({
          model: resolved.instance,
          system: systemPrompt,
          messages: contextMessages,
          tools: hasTools ? aiTools : undefined,
          stopWhen: hasTools ? stepCountIs(maxIter) : stepCountIs(1),
          maxOutputTokens: 4096,
          temperature: 0.7,
          abortSignal: signal,
        });
        finalContent = retryResult.text || '';
        if (retryResult.usage) {
          const u = extractUsage(retryResult.usage as any);
          totalPromptTokens = u.promptTokens;
          totalCompletionTokens = u.completionTokens;
        }
      } else if (agent.fallbackModel && (cat.category === 'model_error' || cat.category === 'rate_limit')) {
        // Try fallback model
        logger.warn({ fallback: agent.fallbackModel }, 'Trying fallback model');
        const fallbackResolved = resolveModel(agent.fallbackModel);
        const fbResult = await retryWithBackoff(() =>
          generateText({
            model: fallbackResolved.instance,
            system: systemPrompt,
            messages: contextMessages,
            tools: hasTools ? aiTools : undefined,
            stopWhen: hasTools ? stepCountIs(maxIter) : stepCountIs(1),
            maxOutputTokens: 4096,
            temperature: 0.7,
            abortSignal: signal,
          }),
        );
        finalContent = fbResult.text || '';
        if (fbResult.usage) {
          const u = extractUsage(fbResult.usage as any);
          totalPromptTokens = u.promptTokens;
          totalCompletionTokens = u.completionTokens;
        }
      } else {
        throw err;
      }
    }

    const durationMs = Date.now() - startTime;

    // If empty after all iterations with tool calls, generate summary
    if (!finalContent && allToolCalls.length > 0) {
      logger.warn({ sessionId }, 'Empty response after tool usage, requesting summary');
      try {
        const summaryResult = await generateText({
          model: resolved.instance,
          system: systemPrompt,
          messages: [
            ...contextMessages,
            { role: 'user' as const, content: 'Please summarize the results of the tool calls that were just executed.' },
          ],
          maxOutputTokens: 1024,
          temperature: 0.5,
        });
        finalContent = summaryResult.text || 'I completed the requested actions but could not generate a summary.';
      } catch {
        finalContent = 'I completed the requested actions but could not generate a summary.';
      }
    } else if (!finalContent) {
      finalContent = 'I processed your request but had no text response to share.';
    }

    const usage = {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
    };

    const metrics: AgentRunMetrics = {
      agentId: agent.id,
      sessionId,
      model: agent.model,
      durationMs,
      iterations,
      toolCallCount: allToolCalls.length,
      ...usage,
    };

    // Emit token usage and metrics
    eventBus.emit('token:usage', {
      agentId: agent.id,
      sessionId,
      model: agent.model,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      timestamp: Date.now(),
    });

    // Store assistant response
    await sessionManager.addMessage({
      sessionId,
      agentId: agent.id,
      role: 'assistant',
      content: finalContent,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      model: agent.model,
      tokensIn: usage.promptTokens,
      tokensOut: usage.completionTokens,
      durationMs,
    });

    eventBus.emit('agent:response', {
      agentId: agent.id,
      sessionId,
      content: finalContent,
      durationMs,
      tokensUsed: usage.totalTokens,
      timestamp: Date.now(),
    });

    logger.info(
      { agentId: agent.id, sessionId, iterations, toolCalls: allToolCalls.length, tokens: usage.totalTokens, durationMs },
      'Agent turn completed',
    );

    if (onChunk) {
      onChunk({ type: 'done', usage });
    }

    return {
      sessionId,
      content: finalContent,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      usage,
      durationMs,
      iterations,
      metrics,
    };
  } catch (err) {
    const cat = categorizeError(err as Error);
    logger.error(
      { agentId: agent.id, category: cat.category, error: (err as Error).message },
      'Agent runtime error',
    );
    agentRegistry.setState(agent.id, 'error');
    eventBus.emit('agent:error', {
      agentId: agent.id,
      sessionId: input.sessionId || '',
      error: (err as Error).message,
      category: cat.category,
      timestamp: Date.now(),
    });
    throw err;
  } finally {
    agentRegistry.setState(agent.id, 'idle');
    eventBus.emit('agent:idle', { agentId: agent.id, timestamp: Date.now() });
  }
}

// ── Import stepCountIs ──
import { stepCountIs } from 'ai';

// ── Streaming variant ──

export interface StreamMessageResult {
  sessionId: string;
  content: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultEntry[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
}

export async function* streamMessage(input: SendMessageInput): AsyncGenerator<
  { sessionId: string; chunk: StreamChunk },
  StreamMessageResult,
  undefined
> {
  const agent = agentRegistry.get(input.agentId) || agentRegistry.getByName(input.agentId);
  if (!agent) throw new Error(`Agent not found: ${input.agentId}`);

  agentRegistry.setState(agent.id, 'processing');

  const abortController = new AbortController();
  const signal = input.abortSignal ?? abortController.signal;
  if (input.abortSignal) {
    input.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  let sessionId: string = input.sessionId ?? '';
  try {
    if (!sessionId) {
      const session = await sessionManager.create(agent.id, input.channelId);
      sessionId = session.id;
    }

    eventBus.emit('agent:processing', { agentId: agent.id, sessionId, timestamp: Date.now() });

    await sessionManager.addMessage({
      sessionId,
      agentId: agent.id,
      role: 'user',
      content: input.text,
      priority: 'high',
    });

    const history = await sessionManager.getMessagesAsCore(sessionId, 50);
    let contextMessages: ModelMessage[] = history;
    if (shouldCompact(history as any[])) {
      const { messages: compacted } = compactMessages(history as any[]);
      contextMessages = compacted as ModelMessage[];
      logger.info({ sessionId }, 'Context compacted before streaming');
    }

    if (!contextMessages.some((m) => m.role === 'user')) {
      contextMessages.push({ role: 'user', content: input.text });
    }

    const memoryContext = memoryManager.buildContext(agent.id);
    const systemPrompt = memoryContext
      ? `${agent.systemPrompt}\n\n${memoryContext}`
      : agent.systemPrompt;

    const maxIter = input.maxIterations || agent.maxIterations || 10;
    const resolved = resolveModel(agent.model);
    const agentTools = toolRegistry.listForAgent(agent.id);

    const aiTools: Record<string, AiTool> = {};
    for (const t of agentTools) {
      aiTools[t.name] = {
        description: t.description,
        inputSchema: jsonSchema(t.parameters as any),
        execute: async (args: Record<string, unknown>) => {
          if (signal.aborted) return { error: 'Aborted' };
          const result = await executeTool(t, args, { agentId: agent.id, sessionId, signal });
          if (result.error) return { error: result.error, content: result.content };
          return result.content;
        },
      } as AiTool;
    }

    const hasTools = Object.keys(aiTools).length > 0;
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResultEntry[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    const streamStartTime = Date.now();
    let fullContent = '';

    // Attempt streaming — with retry on transient failures
    const attemptStream = async function* (modelInstance: any, tools: Record<string, AiTool> | undefined) {
      const stream = streamText({
        model: modelInstance,
        system: systemPrompt,
        messages: contextMessages,
        tools,
        stopWhen: hasTools ? stepCountIs(maxIter) : stepCountIs(1),
        maxOutputTokens: 4096,
        abortSignal: signal,
      });

      for await (const chunk of stream.fullStream) {
        if (signal.aborted) break;

        if (chunk.type === 'text-delta') {
          const text = (chunk as any).delta ?? (chunk as any).text ?? '';
          fullContent += text;
          const streamChunk: StreamChunk = { type: 'delta', content: text };
          yield { sessionId, chunk: streamChunk };
          if (input.onChunk) input.onChunk(streamChunk);
          eventBus.emit('stream:delta', {
            agentId: agent.id,
            sessionId,
            content: text,
            accumulated: fullContent,
            timestamp: Date.now(),
          });
        } else if (chunk.type === 'tool-call') {
          const call: ToolCall = {
            id: chunk.toolCallId,
            name: chunk.toolName,
            arguments: JSON.stringify((chunk as any).input ?? (chunk as any).args),
          };
          allToolCalls.push(call);
          eventBus.emit('agent:tool-call', {
            agentId: agent.id,
            sessionId,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            timestamp: Date.now(),
          });
          const streamChunk: StreamChunk = { type: 'tool_call', toolCall: call };
          yield { sessionId, chunk: streamChunk };
          if (input.onChunk) input.onChunk(streamChunk);
        } else if (chunk.type === 'tool-result') {
          const entry: ToolResultEntry = {
            toolCallId: (chunk as any).toolCallId,
            toolName: (chunk as any).toolName,
            content: String((chunk as any).result),
          };
          allToolResults.push(entry);
          const streamChunk: StreamChunk = { type: 'tool_result', toolResult: entry };
          yield { sessionId, chunk: streamChunk };
          if (input.onChunk) input.onChunk(streamChunk);
        } else if (chunk.type === 'finish') {
          const totalUsage = (chunk as any).totalUsage;
          if (totalUsage) {
            totalPromptTokens = totalUsage.inputTokens ?? 0;
            totalCompletionTokens = totalUsage.outputTokens ?? 0;
            eventBus.emit('token:usage', {
              agentId: agent.id,
              sessionId,
              model: agent.model,
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              timestamp: Date.now(),
            });
          }
        }
      }
    };

    try {
      yield* attemptStream(resolved.instance, hasTools ? aiTools : undefined);
    } catch (err) {
      const cat = categorizeError(err as Error);

      // On context_length error, compact and retry once
      if (cat.category === 'context_length') {
        logger.info({ sessionId }, 'Context length exceeded during streaming, forcing compaction');
        const { messages: compacted } = compactMessages(history as any[], {
          thresholdPercent: 0.5,
          keepLastMessages: 10,
        });
        contextMessages = compacted as ModelMessage[];
        fullContent = '';
        yield* attemptStream(resolved.instance, hasTools ? aiTools : undefined);
      } else if (agent.fallbackModel && (cat.category === 'model_error' || cat.category === 'rate_limit')) {
        // Try fallback model
        logger.warn({ fallback: agent.fallbackModel }, 'Streaming failed, trying fallback model');
        const fallbackResolved = resolveModel(agent.fallbackModel);
        fullContent = '';
        yield* attemptStream(fallbackResolved.instance, hasTools ? aiTools : undefined);
      } else {
        throw err;
      }
    }

    const durationMs = Date.now() - streamStartTime;

    // Emit streaming done
    eventBus.emit('stream:done', {
      agentId: agent.id,
      sessionId,
      content: fullContent,
      durationMs,
      timestamp: Date.now(),
    });

    const usage = {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
    };

    // Yield final done chunk with usage
    const doneChunk: StreamChunk = { type: 'done', usage };
    yield { sessionId, chunk: doneChunk };
    if (input.onChunk) input.onChunk(doneChunk);

    // Store assistant response with complete data
    await sessionManager.addMessage({
      sessionId,
      agentId: agent.id,
      role: 'assistant',
      content: fullContent || 'I processed your request but had no text response to share.',
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      model: agent.model,
      tokensIn: usage.promptTokens,
      tokensOut: usage.completionTokens,
      durationMs,
    });

    eventBus.emit('agent:response', {
      agentId: agent.id,
      sessionId,
      content: fullContent,
      durationMs,
      tokensUsed: usage.totalTokens,
      timestamp: Date.now(),
    });

    return {
      sessionId,
      content: fullContent,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      usage,
      durationMs,
    };
  } catch (err) {
    const cat = categorizeError(err as Error);
    eventBus.emit('stream:error', {
      agentId: agent.id,
      sessionId: sessionId || '',
      error: (err as Error).message,
      timestamp: Date.now(),
    });

    // Yield error chunk before throwing
    const errorChunk: StreamChunk = { type: 'error', error: (err as Error).message };
    yield { sessionId: sessionId || '', chunk: errorChunk };

    throw err;
  } finally {
    agentRegistry.setState(agent.id, 'idle');
    eventBus.emit('agent:idle', { agentId: agent.id, timestamp: Date.now() });
  }
}
