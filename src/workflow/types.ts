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
