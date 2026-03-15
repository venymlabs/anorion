import type { Agent, Message, ToolCall, ToolResultEntry } from '../shared/types';
import { callLlm, streamLlm, type StreamChunk } from '../llm/provider';
import { toolRegistry } from '../tools/registry';
import { executeTool } from '../tools/executor';
import { sessionManager } from './session';
import { agentRegistry } from './registry';
import { logger } from '../shared/logger';

interface RuntimeMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

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

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const agent = agentRegistry.get(input.agentId);
  if (!agent) throw new Error(`Agent not found: ${input.agentId}`);

  agentRegistry.setState(agent.id, 'processing');

  try {
    // Get or create session
    let sessionId = input.sessionId;
    if (!sessionId) {
      const session = await sessionManager.create(agent.id, input.channelId);
      sessionId = session.id;
    }

    // Store user message
    await sessionManager.addMessage({
      sessionId,
      agentId: agent.id,
      role: 'user',
      content: input.text,
    });

    const startTime = Date.now();
    const allToolCalls: ToolCall[] = [];
    const allToolResults: ToolResultEntry[] = [];
    let totalUsage: SendMessageResult['usage'];

    // Build context from history
    const history = await sessionManager.getMessages(sessionId, 50);
    const context: RuntimeMessage[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.role === 'tool' ? { toolCallId: m.toolResults?.[0]?.toolCallId } : {}),
    }));

    // Inference loop
    const maxIter = agent.maxIterations || 10;
    let iterations = 0;

    while (iterations < maxIter) {
      iterations++;
      const agentTools = toolRegistry.listForAgent(agent.id);

      const response = await callLlm({
        systemPrompt: agent.systemPrompt,
        messages: context.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        })),
        tools: agentTools,
        modelId: agent.model,
        fallbackModelId: agent.fallbackModel,
        maxTokens: 4096,
        temperature: 0.7,
      });

      totalUsage = response.usage;

      if (!response.toolCalls.length) {
        // Store assistant response
        await sessionManager.addMessage({
          sessionId,
          agentId: agent.id,
          role: 'assistant',
          content: response.content,
          model: agent.model,
          tokensIn: response.usage?.promptTokens,
          tokensOut: response.usage?.completionTokens,
          durationMs: Date.now() - startTime,
        });

        return {
          sessionId,
          content: response.content,
          toolCalls: allToolCalls,
          toolResults: allToolResults,
          usage: totalUsage,
          durationMs: Date.now() - startTime,
        };
      }

      // Process tool calls
      for (const tc of response.toolCalls) {
        allToolCalls.push(tc);
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
        }

        const toolDef = toolRegistry.get(tc.name);
        if (!toolDef) {
          const errorResult: ToolResultEntry = {
            toolCallId: tc.id,
            toolName: tc.name,
            content: '',
            error: `Unknown tool: ${tc.name}`,
          };
          allToolResults.push(errorResult);
          context.push({ role: 'tool', content: errorResult.error || '', toolCallId: tc.id });
          continue;
        }

        const result = await executeTool(toolDef, args, {
          agentId: agent.id,
          sessionId,
        });

        const toolResult: ToolResultEntry = {
          toolCallId: tc.id,
          toolName: tc.name,
          content: result.content,
          error: result.error,
        };
        allToolResults.push(toolResult);

        context.push({
          role: 'assistant',
          content: '',
          toolCalls: [tc],
        });
        context.push({
          role: 'tool',
          content: result.error ? `Error: ${result.error}` : result.content,
          toolCallId: tc.id,
        });
      }

      // Store tool interaction messages
      await sessionManager.addMessage({
        sessionId,
        agentId: agent.id,
        role: 'assistant',
        content: '',
        toolCalls: response.toolCalls,
        model: agent.model,
      });
    }

    throw new Error(`Max iterations (${maxIter}) reached`);
  } catch (err) {
    logger.error({ agentId: agent.id, error: (err as Error).message }, 'Agent runtime error');
    agentRegistry.setState(agent.id, 'error');
    throw err;
  } finally {
    agentRegistry.setState(agent.id, 'idle');
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

  const history = await sessionManager.getMessages(sessionId, 50);
  const context = history.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system' | 'tool',
    content: m.content,
  }));

  const agentTools = toolRegistry.listForAgent(agent.id);

  const stream = streamLlm({
    systemPrompt: agent.systemPrompt,
    messages: context,
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
