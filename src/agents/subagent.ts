import type { ToolDefinition, ToolContext, ToolResult } from '../shared/types';
import { nanoid } from 'nanoid';
import { agentRegistry } from '../agents/registry';
import { toolRegistry } from '../tools/registry';
import { sessionManager } from '../agents/session';
import { sendMessage } from '../agents/runtime';
import { logger } from '../shared/logger';

const MAX_DEPTH = 2;
const MAX_CONCURRENT = 5;
const DEFAULT_TTL = 5 * 60 * 1000;

interface ChildAgent {
  id: string;
  parentId: string;
  sessionId: string;
  createdAt: number;
  ttl: number;
  depth: number;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const children = new Map<string, Map<string, ChildAgent>>(); // parentId -> childId -> child

function getChildren(parentId: string): Map<string, ChildAgent> {
  if (!children.has(parentId)) children.set(parentId, new Map());
  return children.get(parentId)!;
}

export function spawnSubAgent(params: {
  parentId: string;
  prompt: string;
  tools?: string[];
  ttl?: number;
  depth?: number;
  systemPrompt?: string;
}): Promise<string> {
  const parent = agentRegistry.get(params.parentId);
  if (!parent) throw new Error(`Parent agent not found: ${params.parentId}`);

  const depth = (params.depth || 0) + 1;
  if (depth > MAX_DEPTH) throw new Error(`Max sub-agent depth (${MAX_DEPTH}) exceeded`);

  const siblings = getChildren(params.parentId);
  if (siblings.size >= MAX_CONCURRENT) throw new Error(`Max concurrent children (${MAX_CONCURRENT}) reached`);

  const childId = nanoid(10);
  const ttl = params.ttl || DEFAULT_TTL;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(parent.id, childId);
      reject(new Error('Sub-agent timed out'));
    }, ttl);

    const child: ChildAgent = {
      id: childId,
      parentId: parent.id,
      sessionId: '',
      createdAt: Date.now(),
      ttl,
      depth,
      resolve,
      reject,
      timer,
    };

    siblings.set(childId, child);

    // Filter tools: remove spawn-agent from children to prevent recursion
    const allowedTools = (params.tools || parent.tools).filter((t) => t !== 'spawn-agent');

    // Create ephemeral agent config
    const childConfig = {
      id: childId,
      name: `${parent.name}:child:${childId.slice(0, 6)}`,
      model: parent.model,
      systemPrompt: params.systemPrompt || `You are a sub-agent of ${parent.name}. Complete the task and return a concise result.`,
      tools: allowedTools,
      maxIterations: Math.min(parent.maxIterations || 10, 5),
      timeoutMs: ttl,
      metadata: { parentId: parent.id, depth, ephemeral: true },
    };

    // Create temporary agent
    agentRegistry.create(childConfig).then((agent) => {
      // Bind filtered tools
      toolRegistry.bindTools(agent.id, allowedTools);

      // Run the task
      sendMessage({
        agentId: agent.id,
        text: params.prompt,
      })
        .then((result) => {
          cleanup(parent.id, childId);
          resolve(result.content);
        })
        .catch((err) => {
          cleanup(parent.id, childId);
          reject(err);
        });
    }).catch(reject);

    logger.info({ childId, parentId: parent.id, depth }, 'Sub-agent spawned');
  });
}

function cleanup(parentId: string, childId: string): void {
  const siblings = getChildren(parentId);
  const child = siblings.get(childId);
  if (child) {
    clearTimeout(child.timer);
    siblings.delete(childId);
  }
  // Cleanup ephemeral agent
  agentRegistry.delete(childId).catch(() => {});
}

export function listChildren(parentId: string): { id: string; createdAt: number; depth: number; ttl: number }[] {
  const siblings = getChildren(parentId);
  return [...siblings.values()].map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    depth: c.depth,
    ttl: c.ttl,
  }));
}

export function killChild(parentId: string, childId: string): boolean {
  const siblings = getChildren(parentId);
  const child = siblings.get(childId);
  if (!child) return false;
  child.reject(new Error('Sub-agent killed'));
  cleanup(parentId, childId);
  return true;
}

export function killAllChildren(parentId: string): void {
  const siblings = getChildren(parentId);
  for (const [id] of siblings) {
    killChild(parentId, id);
  }
}

// Register spawn-agent tool
export const spawnAgentTool: ToolDefinition = {
  name: 'spawn-agent',
  description: 'Spawn a sub-agent to handle a task independently. The sub-agent will execute with isolated memory and session. Max depth: 2, max concurrent: 5.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task for the sub-agent to complete' },
      ttl_seconds: { type: 'number', description: 'Timeout in seconds (default 300)' },
    },
    required: ['prompt'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    try {
      const result = await spawnSubAgent({
        parentId: ctx.agentId,
        prompt: String(params.prompt || ''),
        ttl: (params.ttl_seconds as number) ? (params.ttl_seconds as number) * 1000 : DEFAULT_TTL,
      });
      return { content: `Sub-agent result: ${result}` };
    } catch (err) {
      return { content: '', error: `Sub-agent failed: ${(err as Error).message}` };
    }
  },
};
