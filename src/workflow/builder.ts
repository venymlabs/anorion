// Workflow Builder — fluent DSL for constructing DAG workflows
//
// Usage:
//   const workflow = createWorkflow<{ text: string; result?: string }>()
//     .start('analyze')
//     .node('analyze', async (s) => ({ analyzed: true }))
//     .parallel('enrich', [
//       { name: 'sentiment', fn: async (s) => ({ sentiment: 'positive' }) },
//       { name: 'entities', fn: async (s) => ({ entities: [] }) },
//     ])
//     .fanIn('merge', async (s) => ({ merged: true }))
//     .end('merge')
//     .build();

import type {
  NodeFunction,
  ConditionFn,
  CompiledDagGraph,
  RetryConfig,
  MergeFunction,
  RouterConfig,
} from './types';
import { StateGraph } from './graph';

// ── Branch definition for parallel/fan-out ──

export interface BranchDef<T extends Record<string, any>> {
  name: string;
  fn: NodeFunction<T>;
}

// ── Conditional route definition ──

export interface RouteDef<T extends Record<string, any>> {
  name: string;
  condition: (state: T) => boolean;
  fn: NodeFunction<T>;
}

// ── Workflow builder ──

export class WorkflowBuilder<T extends Record<string, any> = Record<string, any>> {
  private graph = new StateGraph<T>();
  private mergeFn?: MergeFunction<T>;
  private lastNode: string | null = null;
  private currentNode: string | null = null;

  /** Set the entry node */
  start(nodeName: string): this {
    this.graph.addEdge('__start__', nodeName);
    this.lastNode = nodeName;
    return this;
  }

  /** Add a standard processing node */
  node(name: string, fn: NodeFunction<T>): this {
    this.graph.addNode(name, fn);

    // Auto-connect from the last node if there's a chain
    if (this.lastNode && this.currentNode === null) {
      // Don't auto-connect — user manages edges explicitly
    }

    this.currentNode = name;
    return this;
  }

  /** Connect two nodes with a static edge */
  connect(from: string, to: string): this {
    this.graph.addEdge(from, to);
    this.lastNode = to;
    return this;
  }

  /** Add a conditional branch */
  conditional(from: string, condition: ConditionFn<T>): this {
    this.graph.addConditionalEdges(from, condition);
    return this;
  }

  /** Add parallel branches from a node */
  parallel(from: string, branches: BranchDef<T>[]): this {
    for (const branch of branches) {
      this.graph.addNode(branch.name, branch.fn);
    }
    this.graph.addParallelEdge(from, branches.map((b) => b.name));
    return this;
  }

  /** Add a fan-out / fan-in pattern */
  fanOut(
    from: string,
    branches: BranchDef<T>[],
    fanInNode: string,
    fanInFn: NodeFunction<T>,
  ): this {
    for (const branch of branches) {
      this.graph.addNode(branch.name, branch.fn);
    }
    this.graph.addNode(fanInNode, fanInFn);
    this.graph.addFanOutFanIn(from, branches.map((b) => b.name), fanInNode);
    this.lastNode = fanInNode;
    return this;
  }

  /** Add a dynamic router node */
  router(from: string, config: RouterConfig<T>): this {
    // A router is a conditional edge with route-based conditions
    this.graph.addConditionalEdges(from, (state) => {
      for (const route of config.routes) {
        if (route.condition(state)) return route.name;
      }
      return config.default ?? '__end__';
    });
    return this;
  }

  /** Add a loop edge */
  loop(
    from: string,
    to: string,
    condition: (state: T) => boolean,
    maxIterations: number,
  ): this {
    this.graph.addLoopEdge(from, to, condition, maxIterations);
    return this;
  }

  /** Configure retry for a node */
  retry(nodeName: string, config: RetryConfig): this {
    this.graph.setRetry(nodeName, config);
    return this;
  }

  /** Set timeout for a node */
  timeout(nodeName: string, ms: number): this {
    this.graph.setTimeout(nodeName, ms);
    return this;
  }

  /** Set a custom merge function for parallel results */
  merge(fn: MergeFunction<T>): this {
    this.mergeFn = fn;
    return this;
  }

  /** Mark a node as terminal (connects to __end__) */
  end(...nodeNames: string[]): this {
    for (const name of nodeNames) {
      this.graph.addEdge(name, '__end__');
    }
    return this;
  }

  /** Build and compile the DAG workflow */
  build(): CompiledDagGraph<T> {
    if (this.mergeFn) {
      this.graph.setMergeFunction(this.mergeFn);
    }
    return this.graph.compileDag();
  }
}

/**
 * Create a new workflow builder with the given state type.
 *
 * @example
 * ```ts
 * const wf = createWorkflow<{ input: string; output?: string }>()
 *   .start('step1')
 *   .node('step1', async (s) => ({ step1Done: true }))
 *   .connect('step1', 'step2')
 *   .node('step2', async (s) => ({ output: 'done' }))
 *   .end('step2')
 *   .build();
 *
 * const result = await wf.invoke({ input: 'hello' });
 * ```
 */
export function createWorkflow<T extends Record<string, any> = Record<string, any>>(): WorkflowBuilder<T> {
  return new WorkflowBuilder<T>();
}
