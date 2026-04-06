// DAG Executor — runs compiled DAG workflows with parallel, conditional, loop support

import type {
  DagNode,
  DagEdgeDef,
  DagInvokeOptions,
  DagStreamEvent,
  MergeFunction,
  Checkpoint,
  ErrorPolicy,
} from './types';
import { START, END } from './types';
import { nanoid } from 'nanoid';
import { logger } from '../shared/logger';

const MAX_ITERATIONS = 100;
const DEFAULT_MAX_CONCURRENCY = 10;

// ── Graph analysis ──

interface DagAnalysis<T extends Record<string, any>> {
  /** Map of node name -> set of predecessor node names (excludes __start__) */
  predecessors: Map<string, Set<string>>;
  /** Map of node name -> outgoing edges */
  outEdges: Map<string, DagEdgeDef<T>[]>;
}

function analyzeDag<T extends Record<string, any>>(
  nodes: Map<string, DagNode<T>>,
  edges: DagEdgeDef<T>[],
): DagAnalysis<T> {
  const predecessors = new Map<string, Set<string>>();
  const outEdges = new Map<string, DagEdgeDef<T>[]>();

  // Initialize
  for (const name of nodes.keys()) {
    predecessors.set(name, new Set());
    outEdges.set(name, []);
  }

  // Process edges to build predecessor/successor maps
  for (const edge of edges) {
    // Store outgoing edges for all sources (including __start__)
    const edgeList = outEdges.get(edge.from) ?? [];
    edgeList.push(edge);
    outEdges.set(edge.from, edgeList);

    // Skip __start__ as a predecessor — it's virtual
    if (edge.from === START) continue;

    const targets = getEdgeTargets(edge);
    for (const t of targets) {
      if (t !== END && predecessors.has(t)) {
        predecessors.get(t)!.add(edge.from);
      }
    }

    // For fan_out edges, also register fan-out targets as predecessors of the fanIn node
    if (edge.type === 'fan_out' && predecessors.has(edge.fanIn)) {
      for (const t of edge.to) {
        predecessors.get(edge.fanIn)!.add(t);
      }
    }
  }

  return { predecessors, outEdges };
}

/** Extract all target node names from an edge */
function getEdgeTargets<T extends Record<string, any>>(edge: DagEdgeDef<T>): string[] {
  switch (edge.type) {
    case 'static':
      return [edge.to];
    case 'parallel':
    case 'fan_out':
      return [...edge.to];
    case 'loop':
      return [edge.to];
    case 'conditional':
      return []; // resolved at runtime
  }
}

/**
 * Topological sort of the DAG nodes.
 * Returns node names in execution order.
 * Throws if a cycle is detected.
 */
export function topologicalSort<T extends Record<string, any>>(
  nodes: Map<string, DagNode<T>>,
  edges: DagEdgeDef<T>[],
): string[] {
  const { predecessors } = analyzeDag(nodes, edges);

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const name of nodes.keys()) {
    // Filter out __start__ from predecessor count
    const preds = predecessors.get(name);
    const count = preds ? [...preds].filter((p) => p !== START).length : 0;
    inDegree.set(name, count);
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    // Find all successors of this node
    for (const edge of edges) {
      if (edge.from !== node) continue;
      const targets = getEdgeTargets(edge);

      for (const t of targets) {
        if (t === END || !inDegree.has(t)) continue;
        const deg = inDegree.get(t)! - 1;
        inDegree.set(t, deg);
        if (deg === 0) queue.push(t);
      }
    }
  }

  if (sorted.length !== nodes.size) {
    const remaining = [...nodes.keys()].filter((n) => !sorted.includes(n));
    throw new Error(`Cycle detected in DAG. Unresolved nodes: ${remaining.join(', ')}`);
  }

  return sorted;
}

/**
 * Detect cycles in the DAG. Returns true if a cycle exists.
 */
export function detectCycle<T extends Record<string, any>>(
  nodes: Map<string, DagNode<T>>,
  edges: DagEdgeDef<T>[],
): boolean {
  try {
    topologicalSort(nodes, edges);
    return false;
  } catch {
    return true;
  }
}

// ── Resolve next nodes from edges ──

interface ResolvedTargets {
  nodes: string[];
  fanInNode?: string;
  loop?: { to: string; condition: (state: any) => boolean; maxIterations: number };
}

function resolveNextNodes<T extends Record<string, any>>(
  nodeId: string,
  state: T,
  outEdges: DagEdgeDef<T>[],
): ResolvedTargets[] {
  const results: ResolvedTargets[] = [];

  for (const edge of outEdges) {
    switch (edge.type) {
      case 'static':
        results.push({ nodes: [edge.to] });
        break;

      case 'conditional': {
        const targets = edge.condition(state);
        const resolved = Array.isArray(targets) ? targets : [targets];
        if (resolved.length > 0) {
          results.push({ nodes: resolved });
        }
        break;
      }

      case 'parallel':
        results.push({ nodes: [...edge.to] });
        break;

      case 'fan_out':
        results.push({
          nodes: [...edge.to],
          fanInNode: edge.fanIn,
        });
        break;

      case 'loop':
        results.push({
          nodes: [edge.to],
          loop: {
            to: edge.to,
            condition: edge.condition,
            maxIterations: edge.maxIterations,
          },
        });
        break;
    }
  }

  return results;
}

// ── Execute a single node with retry/timeout/signal ──

async function executeNode<T extends Record<string, any>>(
  node: DagNode<T>,
  state: T,
  signal?: AbortSignal,
  nodeTimeout?: number,
): Promise<Partial<T>> {
  const retry = node.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('Execution aborted');

    try {
      const execPromise = node.fn(state);

      // Race against signal and timeout
      if (signal || nodeTimeout) {
        const racers: Promise<Partial<T>>[] = [execPromise];

        if (signal) {
          racers.push(
            new Promise<never>((_, reject) => {
              const onAbort = () => reject(new Error('Execution aborted'));
              if (signal.aborted) {
                reject(new Error('Execution aborted'));
              } else {
                signal.addEventListener('abort', onAbort, { once: true });
                // Cleanup listener when execPromise settles
                execPromise.finally(() => signal.removeEventListener('abort', onAbort));
              }
            }),
          );
        }

        if (nodeTimeout) {
          racers.push(
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Node timeout: ${node.name}`)), nodeTimeout),
            ),
          );
        }

        return await Promise.race(racers);
      }

      return await execPromise;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts - 1 && retry?.delayMs) {
        const delay = retry.delayMs * (retry.backoffMultiplier ?? 1) ** attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}

// ── Merge parallel results ──

function defaultMerge<T extends Record<string, any>>(
  results: Map<string, Partial<T>>,
  _state: T,
): Partial<T> {
  const merged: Record<string, any> = {};
  for (const [, partial] of results) {
    Object.assign(merged, partial);
  }
  return merged as Partial<T>;
}

// ── Main DAG executor ──

export async function executeDagGraph<T extends Record<string, any>>(
  nodes: Map<string, DagNode<T>>,
  edges: DagEdgeDef<T>[],
  input: T,
  options: DagInvokeOptions | undefined,
  mergeFn?: MergeFunction<T>,
): Promise<T> {
  const maxIter = options?.maxIterations ?? MAX_ITERATIONS;
  const errorPolicy: ErrorPolicy = options?.onError ?? 'abort';
  const signal = options?.signal;
  const checkpointer = options?.checkpointer;
  const threadId = options?.threadId ?? nanoid(10);
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const nodeTimeout = options?.nodeTimeout;
  const merge = mergeFn ?? defaultMerge;
  const graphId = 'dag';

  const analysis = analyzeDag(nodes, edges);

  // Find initial nodes from START edges
  const startEdges = edges.filter((e) => e.from === START);
  if (startEdges.length === 0) {
    throw new Error('No edge from __start__');
  }

  let state: T = { ...input };
  let lastCheckpointId: string | null = null;
  let iteration = 0;

  const completed = new Set<string>();
  // Track how many fan-out branches must complete before a fan-in node is ready
  const pendingFanIn = new Map<string, number>();
  const loopIterations = new Map<string, number>();

  // Build initial ready set
  const ready: string[] = [];
  for (const edge of startEdges) {
    if (edge.type === 'static') {
      ready.push(edge.to);
    } else if (edge.type === 'parallel' || edge.type === 'fan_out') {
      ready.push(...edge.to);
      if (edge.type === 'fan_out') {
        pendingFanIn.set(edge.fanIn, edge.to.length);
      }
    } else if (edge.type === 'conditional') {
      const targets = edge.condition(state);
      const resolved = Array.isArray(targets) ? targets : [targets];
      ready.push(...resolved);
    }
  }

  while (ready.length > 0 && iteration < maxIter) {
    if (signal?.aborted) throw new Error('DAG execution aborted');

    const batch = ready.splice(0, maxConcurrency);

    if (batch.length === 1) {
      const nodeId = batch[0]!;
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`Unknown node: ${nodeId}`);

      try {
        const partial = await executeNode(node, state, signal, nodeTimeout);
        state = { ...state, ...partial };
        completed.add(nodeId);
        await saveCheckpoint(nodeId);
      } catch (err) {
        if (errorPolicy === 'abort') throw err;
        if (errorPolicy === 'skip') completed.add(nodeId);
      }
    } else {
      // Parallel execution
      const results = await Promise.allSettled(
        batch.map(async (nodeId) => {
          const node = nodes.get(nodeId);
          if (!node) throw new Error(`Unknown node: ${nodeId}`);
          const partial = await executeNode(node, state, signal, nodeTimeout);
          return { nodeId, partial };
        }),
      );

      const branchResults = new Map<string, Partial<T>>();

      for (const result of results) {
        if (result.status === 'fulfilled') {
          completed.add(result.value.nodeId);
          branchResults.set(result.value.nodeId, result.value.partial);
        } else {
          if (errorPolicy === 'abort') throw result.reason;
          if (errorPolicy === 'skip') completed.add(batch[results.indexOf(result)]!);
        }
      }

      // Merge parallel results
      const merged = merge(branchResults, state);
      state = { ...state, ...merged };

      for (const nodeId of batch) {
        if (completed.has(nodeId)) await saveCheckpoint(nodeId);
      }
    }

    // Resolve next nodes for each completed node in this batch
    for (const nodeId of batch) {
      if (!completed.has(nodeId)) continue;

      // Check if this node was a fan-out target that unblocks a fan-in
      for (const [fanInNode, remaining] of pendingFanIn) {
        if (remaining > 0) {
          const preds = analysis.predecessors.get(fanInNode);
          if (preds?.has(nodeId)) {
            pendingFanIn.set(fanInNode, remaining - 1);
            if (remaining - 1 <= 0) {
              pendingFanIn.delete(fanInNode);
              if (!ready.includes(fanInNode) && !completed.has(fanInNode)) {
                ready.push(fanInNode);
              }
            }
          }
        }
      }

      const nodeOutEdges = analysis.outEdges.get(nodeId) ?? [];
      const targetsList = resolveNextNodes(nodeId, state, nodeOutEdges);

      for (const { nodes: targets, fanInNode, loop } of targetsList) {
        // Handle loop edges
        if (loop) {
          const loopKey = `${nodeId}->${loop.to}`;
          const currentIter = loopIterations.get(loopKey) ?? 0;

          if (currentIter < loop.maxIterations && loop.condition(state)) {
            loopIterations.set(loopKey, currentIter + 1);
            ready.push(loop.to);
          }
          continue;
        }

        // Handle fan-out: add all targets to ready, set up fan-in tracking
        if (fanInNode) {
          for (const target of targets) {
            if (!completed.has(target) && !ready.includes(target)) {
              ready.push(target);
            }
          }
          // fan-in tracking already set up from startEdges or will be checked
          if (!pendingFanIn.has(fanInNode)) {
            pendingFanIn.set(fanInNode, targets.length);
          }
          continue;
        }

        // Regular edges
        for (const target of targets) {
          if (target === END) continue;

          const preds = analysis.predecessors.get(target);
          if (!preds || preds.size === 0 || [...preds].every((p) => completed.has(p) || p === START)) {
            if (!completed.has(target) && !ready.includes(target)) {
              ready.push(target);
            }
          }
        }
      }
    }

    iteration++;
  }

  if (iteration >= maxIter) {
    logger.warn({ maxIter }, 'DAG max iterations reached');
  }

  return state;

  async function saveCheckpoint(nodeId: string): Promise<void> {
    if (!checkpointer) return;
    const cpId = nanoid(10);
    await checkpointer.save({
      id: cpId,
      graphId,
      threadId,
      nodeId,
      state: { ...state },
      createdAt: Date.now(),
      parentId: lastCheckpointId,
      metadata: { iteration, dag: true },
    });
    lastCheckpointId = cpId;
  }
}

// ── Streaming DAG executor ──

export async function* executeDagGraphStream<T extends Record<string, any>>(
  nodes: Map<string, DagNode<T>>,
  edges: DagEdgeDef<T>[],
  input: T,
  options: DagInvokeOptions | undefined,
  mergeFn?: MergeFunction<T>,
): AsyncGenerator<DagStreamEvent<T>> {
  const maxIter = options?.maxIterations ?? MAX_ITERATIONS;
  const errorPolicy: ErrorPolicy = options?.onError ?? 'abort';
  const signal = options?.signal;
  const checkpointer = options?.checkpointer;
  const threadId = options?.threadId ?? nanoid(10);
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const nodeTimeout = options?.nodeTimeout;
  const merge = mergeFn ?? defaultMerge;
  const graphId = 'dag';

  const analysis = analyzeDag(nodes, edges);
  const startEdges = edges.filter((e) => e.from === START);

  if (startEdges.length === 0) {
    yield { type: 'error', error: 'No edge from __start__' };
    return;
  }

  let state: T = { ...input };
  let lastCheckpointId: string | null = null;
  let iteration = 0;

  const completed = new Set<string>();
  const pendingFanIn = new Map<string, number>();
  const loopIterations = new Map<string, number>();

  const ready: string[] = [];
  for (const edge of startEdges) {
    if (edge.type === 'static') {
      ready.push(edge.to);
    } else if (edge.type === 'parallel' || edge.type === 'fan_out') {
      ready.push(...edge.to);
      if (edge.type === 'fan_out') {
        pendingFanIn.set(edge.fanIn, edge.to.length);
      }
    } else if (edge.type === 'conditional') {
      const targets = edge.condition(state);
      const resolved = Array.isArray(targets) ? targets : [targets];
      ready.push(...resolved);
    }
  }

  while (ready.length > 0 && iteration < maxIter) {
    if (signal?.aborted) {
      yield { type: 'error', error: 'Aborted' };
      return;
    }

    const batch = ready.splice(0, maxConcurrency);

    if (batch.length > 1) {
      yield { type: 'parallel_start', branches: [...batch] };
    }

    const branchResults = new Map<string, Partial<T>>();

    if (batch.length === 1) {
      const nodeId = batch[0]!;
      const node = nodes.get(nodeId);
      if (!node) {
        yield { type: 'error', nodeId, error: `Unknown node: ${nodeId}` };
        return;
      }

      yield { type: 'node_start', nodeId };
      try {
        const partial = await executeNode(node, state, signal, nodeTimeout);
        state = { ...state, ...partial };
        completed.add(nodeId);
        branchResults.set(nodeId, partial);
        yield { type: 'node_end', nodeId, state };
        await saveCheckpoint(nodeId);
      } catch (err) {
        yield { type: 'error', nodeId, error: (err as Error).message };
        if (errorPolicy === 'abort') return;
        if (errorPolicy === 'skip') completed.add(nodeId);
      }
    } else {
      // Parallel execution
      const results = await Promise.allSettled(
        batch.map(async (nodeId) => {
          const node = nodes.get(nodeId);
          if (!node) throw new Error(`Unknown node: ${nodeId}`);
          const partial = await executeNode(node, state, signal, nodeTimeout);
          return { nodeId, partial };
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const nodeId = batch[i]!;

        if (result.status === 'fulfilled') {
          completed.add(result.value.nodeId);
          branchResults.set(result.value.nodeId, result.value.partial);
          yield { type: 'branch_end', branchId: result.value.nodeId, nodeId: result.value.nodeId };
        } else {
          yield { type: 'error', nodeId, error: (result.reason as Error).message };
          if (errorPolicy === 'abort') return;
          if (errorPolicy === 'skip') completed.add(nodeId);
        }
      }

      // Merge parallel results
      if (branchResults.size > 0) {
        const merged = merge(branchResults, state);
        state = { ...state, ...merged };
      }

      for (const nodeId of batch) {
        if (completed.has(nodeId)) {
          yield { type: 'node_end', nodeId, state };
          await saveCheckpoint(nodeId);
        }
      }

      yield { type: 'parallel_end', branches: [...batch] };
    }

    // Resolve next nodes
    for (const nodeId of batch) {
      if (!completed.has(nodeId)) continue;

      // Check fan-in unlock
      for (const [fanInNode, remaining] of pendingFanIn) {
        if (remaining > 0) {
          const preds = analysis.predecessors.get(fanInNode);
          if (preds?.has(nodeId)) {
            pendingFanIn.set(fanInNode, remaining - 1);
            if (remaining - 1 <= 0) {
              pendingFanIn.delete(fanInNode);
              yield { type: 'fan_in', nodeId: fanInNode };
              if (!ready.includes(fanInNode) && !completed.has(fanInNode)) {
                ready.push(fanInNode);
              }
            }
          }
        }
      }

      const nodeOutEdges = analysis.outEdges.get(nodeId) ?? [];
      const targetsList = resolveNextNodes(nodeId, state, nodeOutEdges);

      for (const { nodes: targets, fanInNode, loop } of targetsList) {
        if (loop) {
          const loopKey = `${nodeId}->${loop.to}`;
          const currentIter = loopIterations.get(loopKey) ?? 0;

          if (currentIter < loop.maxIterations && loop.condition(state)) {
            loopIterations.set(loopKey, currentIter + 1);
            yield { type: 'loop_iteration', nodeId: loop.to, iteration: currentIter + 1 };
            ready.push(loop.to);
          }
          continue;
        }

        if (fanInNode) {
          for (const target of targets) {
            if (!completed.has(target) && !ready.includes(target)) {
              ready.push(target);
            }
          }
          if (!pendingFanIn.has(fanInNode)) {
            pendingFanIn.set(fanInNode, targets.length);
          }
          continue;
        }

        for (const target of targets) {
          if (target === END) continue;
          const preds = analysis.predecessors.get(target);
          if (!preds || preds.size === 0 || [...preds].every((p) => completed.has(p) || p === START)) {
            if (!completed.has(target) && !ready.includes(target)) {
              ready.push(target);
            }
          }
        }
      }
    }

    iteration++;
  }

  yield { type: 'done', state };

  async function saveCheckpoint(nodeId: string): Promise<void> {
    if (!checkpointer) return;
    const cpId = nanoid(10);
    await checkpointer.save({
      id: cpId,
      graphId,
      threadId,
      nodeId,
      state: { ...state },
      createdAt: Date.now(),
      parentId: lastCheckpointId,
      metadata: { iteration, dag: true },
    });
    lastCheckpointId = cpId;
  }
}

/**
 * Build a predecessor map for external queries.
 * Excludes __start__ from dependency lists.
 */
export function buildDependencyMap<T extends Record<string, any>>(
  nodes: Map<string, DagNode<T>>,
  edges: DagEdgeDef<T>[],
): Map<string, string[]> {
  const { predecessors } = analyzeDag(nodes, edges);
  const result = new Map<string, string[]>();
  for (const [name, preds] of predecessors) {
    result.set(name, [...preds].filter((p) => p !== START));
  }
  return result;
}
