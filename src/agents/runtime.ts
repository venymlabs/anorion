import { generateText, type ModelMessage, type Tool as AiTool } from 'ai';
import type { Agent, ToolCall, ToolResultEntry } from '../shared/types';
import { toolRegistry } from '../tools/registry';
import { executeTool } from '../tools/executor';
import { sessionManager } from './session';
import { agentRegistry } from './registry';
import { shouldCompact, compactMessages } from '../memory/context';
import { logger } from '../shared/logger';
import { memoryManager } from '../memory/store';
import { eventBus } from '../shared/events';
import { resolveModel } from '../llm/providers';
import { stepCountIs } from 'ai';

export interface SendMessageInput {
  agentId: string;
  sessionId?: string;
  text: string;
  channelId?: string;
  stream?: boolean;
}

export interface SendMessageResult {
  sessionId: string;
  content: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultEntry[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
}

/**
 * Convert ToolDefinition[] to AI SDK Tool format with execute functions.
 */
function buildAiTools(
  agentId: string,
  sessionId: string,
): Record<string, AiTool> {
  const tools = toolRegistry.listForAgent(agentId);
  const aiTools: Record<string, AiTool> = {};

  for (const tool of tools) {
    aiTools[tool.name] = {
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      execute: async (args: Record<string, unknown>) => {
        try {
          const result = await executeTool(tool, args, { agentId, sessionId });
          if (result.error) {
            return { error: result.error, content: result.content };
          }
          return result.content;
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    };
  }

  return aiTools;
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const agent = agentRegistry.get(input.agentId) || agentRegistry.getByName(input.agentId);
  if (!agent) throw new Error(`Agent not found: ${input.agentId}`);

  agentRegistry.setState(agent.id, 'processing');

  try {
    // Get or create session
    let sessionId = input.sessionId;
    if (!sessionId) {
      const session = await sessionManager.create(agent.id, input.channelId);
      sessionId = session.id;
    }

    eventBus.emit('agent:processing', { agentId: agent.id, sessionId, timestamp: Date.now() });

    // Store user message
    await sessionManager.addMessage({
      sessionId,
      agentId: agent.id,
      role: 'user',
      content: input.text,
    });

    const startTime = Date.now();

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

    const maxIter = agent.maxIterations || 10;
    const aiTools = buildAiTools(agent.id, sessionId);
    const hasTools = Object.keys(aiTools).length > 0;

    // Track tool calls/results for the result object
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResultEntry[] = [];

    const resolved = resolveModel(agent.model);

    let result;
    try {
      result = await generateText({
        model: resolved.instance,
        system: systemPrompt,
        messages: contextMessages,
        tools: hasTools ? aiTools : undefined,
        stopWhen: hasTools ? stepCountIs(maxIter) : stepCountIs(1),
        maxTokens: 4096,
        temperature: 0.7,
        onStepFinish: (step) => {
          // Track tool calls and results from each step
          for (const tc of step.toolCalls) {
            allToolCalls.push({
              id: tc.toolCallId,
              name: tc.toolName,
              arguments: JSON.stringify(tc.args),
            });
            eventBus.emit('agent:tool-call', {
              agentId: agent.id,
              sessionId,
              toolName: tc.toolName,
              toolCallId: tc.toolCallId,
              timestamp: Date.now(),
            });
          }
          for (const tr of step.toolResults) {
            allToolResults.push({
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
            });
          }
        },
      });
    } catch (err) {
      // If primary model fails, try fallback
      const fallback = agent.fallbackModel;
      if (!fallback) throw err;

      logger.warn({ model: agent.model, error: (err as Error).message }, 'Primary model failed, trying fallback');
      const fallbackResolved = resolveModel(fallback);

      result = await generateText({
        model: fallbackResolved.instance,
        system: systemPrompt,
        messages: contextMessages,
        tools: hasTools ? aiTools : undefined,
        stopWhen: hasTools ? stepCountIs(maxIter) : stepCountIs(1),
        maxTokens: 4096,
        temperature: 0.7,
        onStepFinish: (step) => {
          for (const tc of step.toolCalls) {
            allToolCalls.push({
              id: tc.toolCallId,
              name: tc.toolName,
              arguments: JSON.stringify(tc.args),
            });
          }
          for (const tr of step.toolResults) {
            allToolResults.push({
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
            });
          }
        },
      });
    }

    const durationMs = Date.now() - startTime;
    const text = result.text || '';

    // Determine final content — if empty after tool usage, try a summary call
    let finalContent = text;
    if (!finalContent && allToolCalls.length > 0) {
      logger.warn({ sessionId }, 'Empty response after tool usage, requesting summary');
      try {
        const summaryResult = await generateText({
          model: resolved.instance,
          system: systemPrompt,
          messages: contextMessages,
          prompt: 'Please summarize the results of the tool calls that were just executed.',
          maxTokens: 1024,
          temperature: 0.5,
        });
        finalContent = summaryResult.text || 'I completed the requested actions but could not generate a summary.';
      } catch {
        finalContent = 'I completed the requested actions but could not generate a summary.';
      }
    } else if (!finalContent) {
      finalContent = 'I processed your request but had no text response to share.';
    }

    const usage = result.usage
      ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.promptTokens + result.usage.completionTokens,
        }
      : undefined;

    // Emit token usage
    if (usage) {
      eventBus.emit('token:usage', {
        agentId: agent.id,
        sessionId,
        model: agent.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        timestamp: Date.now(),
      });
    }

    // Store assistant response
    await sessionManager.addMessage({
      sessionId,
      agentId: agent.id,
      role: 'assistant',
      content: finalContent,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      model: agent.model,
      tokensIn: usage?.promptTokens,
      tokensOut: usage?.completionTokens,
      durationMs,
    });

    eventBus.emit('agent:response', {
      agentId: agent.id,
      sessionId,
      content: finalContent,
      durationMs,
      tokensUsed: usage?.totalTokens,
      timestamp: Date.now(),
    });

    return {
      sessionId,
      content: finalContent,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      usage,
      durationMs,
    };
  } catch (err) {
    logger.error({ agentId: agent.id, error: (err as Error).message }, 'Agent runtime error');
    agentRegistry.setState(agent.id, 'error');
    eventBus.emit('agent:error', { agentId: agent.id, sessionId: input.sessionId || '', error: (err as Error).message, timestamp: Date.now() });
    throw err;
  } finally {
    agentRegistry.setState(agent.id, 'idle');
    eventBus.emit('agent:idle', { agentId: agent.id, timestamp: Date.now() });
  }
}

export async function* streamMessage(input: SendMessageInput) {
  const agent = agentRegistry.get(input.agentId);
  if (!agent) throw new Error(`Agent not found: ${input.agentId}`);

  let sessionId = input.sessionId;
  if (!sessionId) {
    const session = await sessionManager.create(agent.id, input.channelId);
    sessionId = session.id;
  }

  await sessionManager.addMessage({
    sessionId,
    agentId: agent.id,
    role: 'user',
    content: input.text,
  });

  const history = await sessionManager.getMessagesAsCore(sessionId, 50);
  const { streamLlm } = await import('../llm/provider');

  const agentTools = toolRegistry.listForAgent(agent.id);
  const memoryContext = memoryManager.buildContext(agent.id);

  const stream = streamLlm({
    systemPrompt: memoryContext
      ? `${agent.systemPrompt}\n\n${memoryContext}`
      : agent.systemPrompt,
    messages: history,
    tools: agentTools,
    modelId: agent.model,
    maxTokens: 4096,
  });

  let fullContent = '';
  for await (const chunk of stream) {
    yield { sessionId, chunk };
    if (chunk.type === 'delta') {
      fullContent += chunk.content;
    }
  }

  await sessionManager.addMessage({
    sessionId,
    agentId: agent.id,
    role: 'assistant',
    content: fullContent,
    model: agent.model,
  });
}
