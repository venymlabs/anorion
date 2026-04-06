// Graph-Based Workflow Engine Types

/** A node in the workflow graph. Receives state, returns partial state update. */
export type NodeFunction<T extends Record<string, any>> = (
  state: T,
) => Promise<Partial<T>>;

/** A condition function for conditional edges. Returns the name of the next node. */
export type ConditionFn<T extends Record<string, any>> = (
  state: T,
) => string | string[];

/** Static or conditional edge definition */
export type EdgeDef<T extends Record<string, any>> =
  | { type: 'static'; from: string; to: string }
  | { type: 'conditional'; from: string; condition: ConditionFn<T> };

/** A snapshot of graph state at a point in time */
export interface StateSnapshot<T extends Record<string, any> = Record<string, any>> {
  nodeId: string;
  state: T;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** A compiled graph ready for execution */
export interface CompiledGraph<T extends Record<string, any>> {
  invoke(input: T, options?: InvokeOptions): Promise<T>;
  stream(input: T, options?: InvokeOptions): AsyncIterable<GraphStreamEvent<T>>;
}

export interface InvokeOptions {
  checkpointer?: Checkpointer;
  threadId?: string;
  signal?: AbortSignal;
  maxIterations?: number;
  onError?: ErrorPolicy;
}

export type ErrorPolicy = 'retry' | 'skip' | 'abort';

export interface GraphStreamEvent<T = Record<string, any>> {
  type: 'node_start' | 'node_end' | 'edge' | 'done' | 'error';
  nodeId?: string;
  state?: T;
  error?: string;
}

/** Checkpointer interface for state persistence */
export interface Checkpoint {
  id: string;
  graphId: string;
  threadId: string;
  nodeId: string;
  state: Record<string, any>;
  createdAt: number;
  parentId: string | null;
  metadata: Record<string, any>;
}

export interface Checkpointer {
  save(checkpoint: Checkpoint): Promise<void>;
  load(id: string): Promise<Checkpoint | null>;
  list(graphId: string, threadId: string, options?: { limit?: number }): Promise<Checkpoint[]>;
  getLatest(graphId: string, threadId: string): Promise<Checkpoint | null>;
}

/** Internal node representation */
export interface GraphNode<T extends Record<string, any>> {
  name: string;
  fn: NodeFunction<T>;
}

/** Sentinel node names */
export const START = '__start__';
export const END = '__end__';

// ── DAG Extension Types ──

/** Retry configuration for a node */
export interface RetryConfig {
  maxAttempts: number;
  delayMs?: number;
  backoffMultiplier?: number;
}

/** Loop configuration — re-execute until condition is false */
export interface LoopConfig<T extends Record<string, any>> {
  while: (state: T) => boolean;
  maxIterations: number;
  delayMs?: number;
}

/** Router configuration — dynamic routing based on state analysis */
export interface RouterConfig<T extends Record<string, any>> {
  routes: Array<{
    name: string;
    condition: (state: T) => boolean;
  }>;
  default?: string;
}

/** Extended node with DAG features */
export interface DagNode<T extends Record<string, any>> extends GraphNode<T> {
  retry?: RetryConfig;
  timeout?: number;
}

/** Merge function for combining parallel branch results */
export type MergeFunction<T extends Record<string, any>> = (
  results: Map<string, Partial<T>>,
  state: T,
) => Partial<T>;

/** Extended edge types for DAG workflows */
export type DagEdgeDef<T extends Record<string, any>> =
  | EdgeDef<T>
  | { type: 'parallel'; from: string; to: string[] }
  | { type: 'fan_out'; from: string; to: string[]; fanIn: string }
  | { type: 'loop'; from: string; to: string; condition: (state: T) => boolean; maxIterations: number };

/** Extended stream events for DAG execution */
export interface DagStreamEvent<T = Record<string, any>> {
  type:
    | 'node_start'
    | 'node_end'
    | 'edge'
    | 'done'
    | 'error'
    | 'parallel_start'
    | 'parallel_end'
    | 'branch_start'
    | 'branch_end'
    | 'loop_iteration'
    | 'fan_out'
    | 'fan_in'
    | 'router_decision';
  nodeId?: string;
  state?: T;
  error?: string;
  branchId?: string;
  iteration?: number;
  branches?: string[];
  route?: string;
}

/** Extended invoke options for DAG execution */
export interface DagInvokeOptions extends InvokeOptions {
  maxConcurrency?: number;
  nodeTimeout?: number;
}

/** A compiled DAG graph ready for execution */
export interface CompiledDagGraph<T extends Record<string, any>> {
  invoke(input: T, options?: DagInvokeOptions): Promise<T>;
  stream(input: T, options?: DagInvokeOptions): AsyncGenerator<DagStreamEvent<T>>;
  /** Get the topological execution order (static analysis, before conditional resolution) */
  topologicalOrder(): string[];
  /** Get dependencies of a node */
  dependencies(nodeId: string): string[];
}
