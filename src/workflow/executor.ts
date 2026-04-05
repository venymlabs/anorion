// Graph Executor — runs compiled graph workflows

import type {
  GraphNode,
  EdgeDef,
  InvokeOptions,
  GraphStreamEvent,
  Checkpoint,
  ErrorPolicy,
} from './types';
import { START, END } from './types';
import { nanoid } from 'nanoid';
import { logger } from '../shared/logger';

const MAX_ITERATIONS = 100;

/**
 * Execute a compiled graph and return the final state.
 */
export async function executeGraph<T extends Record<string, any>>(
  nodes: Map<string, GraphNode<T>>,
  edges: EdgeDef<T>[],
  input: T,
  options: InvokeOptions | undefined,
  streaming: boolean,
): Promise<T> {
  const maxIter = options?.maxIterations ?? MAX_ITERATIONS;
  const errorPolicy: ErrorPolicy = options?.onError ?? 'abort';
  const signal = options?.signal;
  const checkpointer = options?.checkpointer;
  const threadId = options?.threadId ?? nanoid(10);
  const graphId = 'graph';

  let state: T = { ...input };

  // Find initial node from __start__
  const startEdges = edges.filter((e) => e.from === START);
  if (startEdges.length === 0) {
    throw new Error('No edge from __start__');
  }

  const startEdge = startEdges[0]!;
  let currentNode: string | null;

  if (startEdge.type === 'static') {
    currentNode = startEdge.to;
  } else {
    const targets = startEdge.condition(state);
    currentNode = Array.isArray(targets) ? targets[0]! : targets;
  }

  let iteration = 0;
  let lastCheckpointId: string | null = null;

  while (currentNode && currentNode !== END && iteration < maxIter) {
    if (signal?.aborted) {
      throw new Error('Graph execution aborted');
    }

    const node = nodes.get(currentNode);
    if (!node) {
      throw new Error(`Unknown node: ${currentNode}`);
    }

    try {
      const partial = await node.fn(state);
      state = { ...state, ...partial };

      // Save checkpoint
      if (checkpointer) {
        const cpId = nanoid(10);
        await checkpointer.save({
          id: cpId,
          graphId,
          threadId,
          nodeId: currentNode,
          state: { ...state },
          createdAt: Date.now(),
          parentId: lastCheckpointId,
          metadata: { iteration },
        });
        lastCheckpointId = cpId;
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.warn({ nodeId: currentNode, error: errMsg, iteration }, 'Graph node error');

      if (errorPolicy === 'abort') {
        throw err;
      }
      if (errorPolicy === 'retry') {
        try {
          const partial = await node.fn(state);
          state = { ...state, ...partial };
        } catch (retryErr) {
          throw retryErr;
        }
      }
      // 'skip' — state unchanged, continue
    }

    // Resolve next node from edges
    const nodeEdges = edges.filter((e) => e.from === currentNode);
    if (nodeEdges.length === 0) {
      currentNode = null;
      break;
    }

    let nextNode: string | null = null;
    for (const edge of nodeEdges) {
      if (edge.type === 'static') {
        nextNode = edge.to;
        break;
      } else {
        const targets = edge.condition(state);
        const resolved = Array.isArray(targets) ? targets[0] ?? null : targets;
        if (resolved) {
          nextNode = resolved;
          break;
        }
      }
    }

    currentNode = nextNode;
    iteration++;
  }

  if (iteration >= maxIter) {
    logger.warn({ maxIter }, 'Graph max iterations reached');
  }

  return state;
}

/**
 * Execute a compiled graph and yield streaming events.
 */
export async function* executeGraphStream<T extends Record<string, any>>(
  nodes: Map<string, GraphNode<T>>,
  edges: EdgeDef<T>[],
  input: T,
  options: InvokeOptions | undefined,
): AsyncGenerator<GraphStreamEvent<T>> {
  const maxIter = options?.maxIterations ?? MAX_ITERATIONS;
  const errorPolicy: ErrorPolicy = options?.onError ?? 'abort';
  const signal = options?.signal;
  const checkpointer = options?.checkpointer;
  const threadId = options?.threadId ?? nanoid(10);
  const graphId = 'graph';

  let state: T = { ...input };

  const startEdges = edges.filter((e) => e.from === START);
  if (startEdges.length === 0) {
    throw new Error('No edge from __start__');
  }

  const startEdge = startEdges[0]!;
  let currentNode: string | null;

  if (startEdge.type === 'static') {
    currentNode = startEdge.to;
  } else {
    const targets = startEdge.condition(state);
    currentNode = Array.isArray(targets) ? targets[0]! : targets;
  }

  let iteration = 0;
  let lastCheckpointId: string | null = null;

  while (currentNode && currentNode !== END && iteration < maxIter) {
    if (signal?.aborted) {
      yield { type: 'error', error: 'Aborted' };
      return;
    }

    const node = nodes.get(currentNode);
    if (!node) {
      yield { type: 'error', error: `Unknown node: ${currentNode}` };
      return;
    }

    yield { type: 'node_start', nodeId: currentNode };

    try {
      const partial = await node.fn(state);
      state = { ...state, ...partial };
      yield { type: 'node_end', nodeId: currentNode, state };

      if (checkpointer) {
        const cpId = nanoid(10);
        await checkpointer.save({
          id: cpId,
          graphId,
          threadId,
          nodeId: currentNode,
          state: { ...state },
          createdAt: Date.now(),
          parentId: lastCheckpointId,
          metadata: { iteration },
        });
        lastCheckpointId = cpId;
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      yield { type: 'error', nodeId: currentNode, error: errMsg };

      if (errorPolicy === 'abort') {
        return;
      }
      if (errorPolicy === 'retry') {
        try {
          const partial = await node.fn(state);
          state = { ...state, ...partial };
          yield { type: 'node_end', nodeId: currentNode, state };
        } catch {
          return;
        }
      }
    }

    const nodeEdges = edges.filter((e) => e.from === currentNode);
    if (nodeEdges.length === 0) {
      currentNode = null;
      break;
    }

    let nextNode: string | null = null;
    for (const edge of nodeEdges) {
      if (edge.type === 'static') {
        nextNode = edge.to;
        break;
      } else {
        const targets = edge.condition(state);
        const resolved = Array.isArray(targets) ? targets[0] ?? null : targets;
        if (resolved) {
          nextNode = resolved;
          break;
        }
      }
    }

    currentNode = nextNode;
    iteration++;
  }

  yield { type: 'done', state };
}
