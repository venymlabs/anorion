// Agent Handoff Protocol
// Agents declare handoffs in their config. The runtime auto-creates handoff_to_<agent> tools.
// When the LLM calls a handoff tool, conversation transfers to the target agent.

import type { Message, ToolDefinition, ToolContext, ToolResult } from '../shared/types';
import { toolRegistry } from '../tools/registry';
import { agentRegistry } from './registry';
import { sendMessage } from './runtime';
import { sessionManager } from './session';
import { logger } from '../shared/logger';
import { eventBus } from '../shared/events';

export interface AgentHandoff {
  /** Target agent ID or name */
  targetAgentId: string;
  /** Description of when to hand off (LLM uses this to decide) */
  description: string;
  /** Filter which messages carry over to the target agent */
  filterMessages?: (messages: Message[]) => Message[];
  /** Callback when handoff occurs */
  onHandoff?: (from: string, to: string, context: HandoffContext) => Promise<void>;
}

export interface HandoffContext {
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
  messages: Message[];
  reason?: string;
}

// Track registered handoff tools so we can clean up
const registeredHandoffTools = new Map<string, string>(); // toolName -> sourceAgentId

/**
 * Register handoff tools for an agent based on its declared handoffs.
 */
export function registerHandoffTools(
  agentId: string,
  handoffs: AgentHandoff[],
): void {
  for (const handoff of handoffs) {
    const toolName = `handoff_to_${handoff.targetAgentId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    // Skip if already registered (e.g., multiple agents hand off to same target)
    if (toolRegistry.get(toolName)) continue;

    const toolDef: ToolDefinition = {
      name: toolName,
      description: `Transfer the conversation to the ${handoff.targetAgentId} agent. Use this when: ${handoff.description}`,
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief reason for the handoff',
          },
          message: {
            type: 'string',
            description: 'Optional message to pass to the target agent',
          },
        },
        required: [],
      },
      execute: async (
        params: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        return executeHandoff(handoff, params, ctx);
      },
    };

    toolRegistry.register(toolDef);
    registeredHandoffTools.set(toolName, agentId);

    logger.info({ agentId, targetAgent: handoff.targetAgentId, toolName }, 'Handoff tool registered');
  }

  // Bind handoff tool names to the agent
  const existingTools = toolRegistry.getToolNamesForAgent(agentId);
  const handoffToolNames = handoffs.map((h) =>
    `handoff_to_${h.targetAgentId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  );
  toolRegistry.bindTools(agentId, [...existingTools, ...handoffToolNames]);
}

/**
 * Execute a handoff: transfer conversation to target agent.
 */
async function executeHandoff(
  handoff: AgentHandoff,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const targetAgent = agentRegistry.get(handoff.targetAgentId) ||
    agentRegistry.getByName(handoff.targetAgentId);

  if (!targetAgent) {
    return {
      content: '',
      error: `Handoff target agent not found: ${handoff.targetAgentId}`,
    };
  }

  const reason = String(params.reason || '');
  const message = String(params.message || '');

  try {
    // Get conversation history
    const messages = await sessionManager.getMessages(ctx.sessionId, 50);

    // Apply message filter if provided
    const filteredMessages = handoff.filterMessages
      ? handoff.filterMessages(messages)
      : messages;

    // Build context for target agent
    const contextSummary = filteredMessages.length > 0
      ? `[Previous conversation context]\n${filteredMessages
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
          .join('\n')}\n\n`
      : '';

    const handoffPrompt = reason
      ? `${contextSummary}[Handoff from ${ctx.agentId}] Reason: ${reason}${message ? '\nMessage: ' + message : ''}`
      : `${contextSummary}[Handoff from ${ctx.agentId}]${message ? '\n' + message : ''}`;

    // Fire handoff event
    const handoffCtx: HandoffContext = {
      fromAgentId: ctx.agentId,
      toAgentId: targetAgent.id,
      sessionId: ctx.sessionId,
      messages: filteredMessages,
      reason,
    };

    eventBus.emit('agent:handoff', {
      from: ctx.agentId,
      to: targetAgent.id,
      sessionId: ctx.sessionId,
      reason,
      timestamp: Date.now(),
    });

    // Call onHandoff callback
    if (handoff.onHandoff) {
      await handoff.onHandoff(ctx.agentId, targetAgent.id, handoffCtx);
    }

    // Send message to target agent in same session
    const result = await sendMessage({
      agentId: targetAgent.id,
      sessionId: ctx.sessionId,
      text: handoffPrompt,
    });

    return {
      content: result.content,
      metadata: {
        handoff: true,
        fromAgent: ctx.agentId,
        toAgent: targetAgent.id,
      },
    };
  } catch (err) {
    logger.error(
      { from: ctx.agentId, to: targetAgent.id, error: (err as Error).message },
      'Handoff failed',
    );
    return {
      content: '',
      error: `Handoff failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Get handoff tool names for a given set of handoffs.
 */
export function getHandoffToolNames(handoffs: AgentHandoff[]): string[] {
  return handoffs.map((h) =>
    `handoff_to_${h.targetAgentId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  );
}

/**
 * Unregister handoff tools for an agent.
 */
export function unregisterHandoffTools(agentId: string): void {
  for (const [toolName, sourceId] of registeredHandoffTools) {
    if (sourceId === agentId) {
      registeredHandoffTools.delete(toolName);
      // Note: we don't unregister from toolRegistry as it doesn't support it
      // This is fine for now since tool names are deterministic
    }
  }
}
