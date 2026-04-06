// Collaboration Tools — delegate, vote, challenge, summarize
// These tools can be bound to agents for in-conversation collaboration

import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { sendMessage } from '../runtime';
import { agentRegistry } from '../registry';
import { logger } from '../../shared/logger';

// ── Delegate Tool ──
// Delegates a subtask to another agent

export const delegateTool: ToolDefinition = {
  name: 'collaborate-delegate',
  description: 'Delegate a task to another agent. The agent will work independently and return its result.',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'ID or name of the agent to delegate to' },
      task: { type: 'string', description: 'The task description for the agent' },
      timeout_seconds: { type: 'number', description: 'Timeout in seconds (default: 60)' },
    },
    required: ['agent_id', 'task'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const agentId = String(params.agent_id || '');
    const task = String(params.task || '');
    const timeoutMs = ((params.timeout_seconds as number) || 60) * 1000;

    const agent = agentRegistry.get(agentId) || agentRegistry.getByName(agentId);
    if (!agent) return { content: '', error: `Agent not found: ${agentId}` };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Link parent signal
    if (ctx.signal.aborted) {
      clearTimeout(timer);
      return { content: '', error: 'Parent signal already aborted' };
    }
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const result = await sendMessage({
        agentId: agent.id,
        text: `[Delegated by agent ${ctx.agentId}]\n\n${task}`,
        abortSignal: controller.signal,
      });

      logger.info({ from: ctx.agentId, to: agent.id, durationMs: result.durationMs }, 'Delegation completed');

      return {
        content: result.content,
        metadata: { delegatedTo: agent.id, tokens: result.usage?.totalTokens },
      };
    } catch (err) {
      return { content: '', error: `Delegation failed: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  },
};

// ── Vote Tool ──
// Collects votes from multiple agents on a question

export const voteTool: ToolDefinition = {
  name: 'collaborate-vote',
  description: 'Collect votes from multiple agents on a question or proposal. Returns aggregated results.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question or proposal to vote on' },
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of agent IDs or names to collect votes from',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of options to choose from',
      },
      timeout_seconds: { type: 'number', description: 'Timeout per agent in seconds (default: 30)' },
    },
    required: ['question', 'agents'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const question = String(params.question || '');
    const agentIds = (params.agents as string[]) || [];
    const options = (params.options as string[]) || undefined;
    const timeoutMs = ((params.timeout_seconds as number) || 30) * 1000;

    if (agentIds.length === 0) return { content: '', error: 'No agents specified for voting' };

    const prompt = options
      ? `Vote on the following question by choosing exactly one option.\n\nQuestion: ${question}\nOptions: ${options.join(', ')}\n\nRespond with ONLY your chosen option.`
      : `Vote on the following question. Be brief.\n\nQuestion: ${question}\n\nRespond with your vote in one line.`;

    // Collect votes in parallel
    const results = await Promise.allSettled(
      agentIds.map(async (idOrName) => {
        const agent = agentRegistry.get(idOrName) || agentRegistry.getByName(idOrName);
        if (!agent) throw new Error(`Agent not found: ${idOrName}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const result = await sendMessage({
            agentId: agent.id,
            text: prompt,
            abortSignal: controller.signal,
          });
          return { agentId: agent.id, agentName: agent.name, vote: result.content.trim() };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    const votes: Array<{ agentId: string; agentName: string; vote: string }> = [];
    const errors: string[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled') {
        votes.push(r.value);
      } else {
        errors.push(r.reason?.message || 'Unknown error');
      }
    }

    // Count votes
    const tally = new Map<string, number>();
    for (const v of votes) {
      const key = v.vote.toLowerCase();
      tally.set(key, (tally.get(key) || 0) + 1);
    }

    const summary = [
      'Vote Results:',
      ...votes.map((v) => `  ${v.agentName}: ${v.vote}`),
      '',
      'Tally:',
      ...[...tally.entries()].sort(([, a], [, b]) => b - a).map(([k, v]) => `  ${k}: ${v} vote(s)`),
    ];

    if (errors.length > 0) {
      summary.push('', 'Errors:', ...errors.map((e) => `  - ${e}`));
    }

    return {
      content: summary.join('\n'),
      metadata: { votes: votes.length, errors: errors.length, tally: Object.fromEntries(tally) },
    };
  },
};

// ── Challenge Tool ──
// Asks another agent to critique or challenge a position

export const challengeTool: ToolDefinition = {
  name: 'collaborate-challenge',
  description: 'Ask another agent to critique, challenge, or find flaws in a position or argument. Useful for improving reasoning.',
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'ID or name of the agent to challenge with' },
      position: { type: 'string', description: 'The position or argument to challenge' },
      focus: { type: 'string', description: 'Optional focus area for the challenge', enum: ['logic', 'evidence', 'completeness', 'bias'] },
    },
    required: ['agent_id', 'position'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const agentId = String(params.agent_id || '');
    const position = String(params.position || '');
    const focus = String(params.focus || 'logic');

    const agent = agentRegistry.get(agentId) || agentRegistry.getByName(agentId);
    if (!agent) return { content: '', error: `Agent not found: ${agentId}` };

    const prompt = `You are reviewing and challenging the following position. Focus on finding ${focus} flaws, weaknesses, or counterarguments.\n\nPosition:\n${position}\n\nProvide a rigorous critique. Be constructive but thorough.`;

    try {
      const result = await sendMessage({
        agentId: agent.id,
        text: prompt,
        abortSignal: ctx.signal,
      });

      return {
        content: result.content,
        metadata: { challengedBy: agent.id, focus },
      };
    } catch (err) {
      return { content: '', error: `Challenge failed: ${(err as Error).message}` };
    }
  },
};

// ── Summarize Tool ──
// Asks an agent to summarize multiple inputs

export const summarizeTool: ToolDefinition = {
  name: 'collaborate-summarize',
  description: 'Summarize and synthesize multiple inputs, outputs, or perspectives into a coherent summary.',
  parameters: {
    type: 'object',
    properties: {
      inputs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of text inputs to summarize',
      },
      agent_id: { type: 'string', description: 'Optional agent ID to use for summarization' },
      style: { type: 'string', description: 'Summary style', enum: ['concise', 'detailed', 'bullet-points', 'synthesis'] },
    },
    required: ['inputs'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const inputs = (params.inputs as string[]) || [];
    const agentId = String(params.agent_id || '') || ctx.agentId;
    const style = String(params.style || 'synthesis');

    if (inputs.length === 0) return { content: '', error: 'No inputs to summarize' };

    const styleInstructions: Record<string, string> = {
      concise: 'Provide a very concise summary in 2-3 sentences.',
      detailed: 'Provide a detailed summary covering all key points.',
      'bullet-points': 'Summarize as a list of key bullet points.',
      synthesis: 'Synthesize the inputs into a coherent narrative that captures the key themes.',
    };

    const prompt = `${styleInstructions[style] || styleInstructions.synthesis}\n\nInputs:\n${inputs.map((input, i) => `[Input ${i + 1}]\n${input}`).join('\n\n---\n\n')}`;

    try {
      const result = await sendMessage({
        agentId,
        text: prompt,
        abortSignal: ctx.signal,
      });

      return { content: result.content };
    } catch (err) {
      return { content: '', error: `Summarization failed: ${(err as Error).message}` };
    }
  },
};

// ── Register all collaboration tools ──

export const collaborationTools: ToolDefinition[] = [
  delegateTool,
  voteTool,
  challengeTool,
  summarizeTool,
];
