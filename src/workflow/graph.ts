// StateGraph — fluent API for building workflow graphs

import type {
  NodeFunction,
  ConditionFn,
  EdgeDef,
  GraphNode,
  CompiledGraph,
  InvokeOptions,
  GraphStreamEvent,
  ErrorPolicy,
  DagNode,
  DagEdgeDef,
  DagInvokeOptions,
  DagStreamEvent,
  CompiledDagGraph,
  RetryConfig,
  MergeFunction,
} from './types';
import { executeGraph, executeGraphStream } from './executor';
import {
  executeDagGraph,
  executeDagGraphStream,
  topologicalSort,
  buildDependencyMap,
  detectCycle,
} from './dag';
import { START, END } from './types';

export class StateGraph<T extends Record<string, any> = Record<string, any>> {
  private nodes = new Map<string, GraphNode<T>>();
  private edges: EdgeDef<T>[] = [];

  // DAG extensions
  private dagNodes = new Map<string, DagNode<T>>();
  private dagEdges: DagEdgeDef<T>[] = [];
  private dagRetry = new Map<string, RetryConfig>();
  private dagTimeout = new Map<string, number>();
  private mergeFn?: MergeFunction<T>;

  addNode(name: string, fn: NodeFunction<T>): this {
    if (name === START || name === END) {
      throw new Error(`Cannot add node with reserved name: ${name}`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`Node already exists: ${name}`);
    }
    this.nodes.set(name, { name, fn });
    // Also add to DAG nodes
    this.dagNodes.set(name, { name, fn });
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.push({ type: 'static', from, to });
    this.dagEdges.push({ type: 'static', from, to });
    return this;
  }

  addConditionalEdges(from: string, condition: ConditionFn<T>): this {
    this.edges.push({ type: 'conditional', from, condition });
    this.dagEdges.push({ type: 'conditional', from, condition });
    return this;
  }

  // ── DAG extensions ──

  /** Configure retry for a node */
  setRetry(nodeName: string, config: RetryConfig): this {
    if (!this.dagNodes.has(nodeName)) {
      throw new Error(`Node not found: ${nodeName}`);
    }
    this.dagRetry.set(nodeName, config);
    return this;
  }

  /** Set timeout for a node (in ms) */
  setTimeout(nodeName: string, ms: number): this {
    if (!this.dagNodes.has(nodeName)) {
      throw new Error(`Node not found: ${nodeName}`);
    }
    this.dagTimeout.set(nodeName, ms);
    return this;
  }

  /** Add a parallel edge — all target nodes run simultaneously */
  addParallelEdge(from: string, to: string[]): this {
    if (to.length < 2) {
      throw new Error('Parallel edge requires at least 2 targets');
    }
    this.dagEdges.push({ type: 'parallel', from, to });
    return this;
  }

  /** Add a fan-out / fan-in pattern */
  addFanOutFanIn(from: string, targets: string[], fanInNode: string): this {
    if (targets.length < 2) {
      throw new Error('Fan-out requires at least 2 targets');
    }
    if (!this.dagNodes.has(fanInNode)) {
      throw new Error(`Fan-in node not found: ${fanInNode}`);
    }
    for (const t of targets) {
      if (!this.dagNodes.has(t)) {
        throw new Error(`Fan-out target node not found: ${t}`);
      }
    }
    this.dagEdges.push({ type: 'fan_out', from, to: targets, fanIn: fanInNode });
    return this;
  }

  /** Add a loop edge — re-execute target node while condition is true */
  addLoopEdge(
    from: string,
    to: string,
    condition: (state: T) => boolean,
    maxIterations: number,
  ): this {
    this.dagEdges.push({ type: 'loop', from, to, condition, maxIterations });
    return this;
  }

  /** Set a custom merge function for parallel branch results */
  setMergeFunction(fn: MergeFunction<T>): this {
    this.mergeFn = fn;
    return this;
  }

  compile(): CompiledGraph<T> {
    // Validate: at least one node + edges from __start__
    const nodeNames = new Set(this.nodes.keys());
    if (nodeNames.size === 0) {
      throw new Error('Graph must have at least one node');
    }

    const hasStartEdge = this.edges.some((e) => e.from === START);
    if (!hasStartEdge) {
      throw new Error('Graph must have at least one edge from __start__');
    }

    // Validate edge targets exist
    for (const edge of this.edges) {
      if (edge.from !== START && !nodeNames.has(edge.from)) {
        throw new Error(`Edge references unknown source node: ${edge.from}`);
      }
      if (edge.type === 'static' && edge.to !== END && !nodeNames.has(edge.to)) {
        throw new Error(`Edge references unknown target node: ${edge.to}`);
      }
    }

    // Snapshot the graph definition
    const nodes = new Map(this.nodes);
    const edges = [...this.edges];

    return {
      async invoke(input: T, options?: InvokeOptions): Promise<T> {
        return executeGraph(nodes, edges, input, options, false);
      },

      async *stream(input: T, options?: InvokeOptions): AsyncGenerator<GraphStreamEvent<T>> {
        yield* executeGraphStream(nodes, edges, input, options);
      },
    };
  }

  /**
   * Compile as a DAG graph with support for parallel execution,
   * conditional branching, loops, and fan-out/fan-in.
   */
  compileDag(): CompiledDagGraph<T> {
    const nodeNames = new Set(this.dagNodes.keys());
    if (nodeNames.size === 0) {
      throw new Error('DAG must have at least one node');
    }

    const hasStartEdge = this.dagEdges.some((e) => e.from === START);
    if (!hasStartEdge) {
      throw new Error('DAG must have at least one edge from __start__');
    }

    // Validate all edge references
    for (const edge of this.dagEdges) {
      if (edge.from !== START && !nodeNames.has(edge.from)) {
        throw new Error(`Edge references unknown source node: ${edge.from}`);
      }
      switch (edge.type) {
        case 'static':
          if (edge.to !== END && !nodeNames.has(edge.to)) {
            throw new Error(`Edge references unknown target node: ${edge.to}`);
          }
          break;
        case 'parallel':
          for (const t of edge.to) {
            if (t !== END && !nodeNames.has(t)) {
              throw new Error(`Parallel edge references unknown target: ${t}`);
            }
          }
          break;
        case 'fan_out':
          for (const t of edge.to) {
            if (!nodeNames.has(t)) {
              throw new Error(`Fan-out edge references unknown target: ${t}`);
            }
          }
          if (!nodeNames.has(edge.fanIn)) {
            throw new Error(`Fan-in node not found: ${edge.fanIn}`);
          }
          break;
        case 'loop':
          if (!nodeNames.has(edge.to)) {
            throw new Error(`Loop edge references unknown target: ${edge.to}`);
          }
          break;
      }
    }

    // Apply retry/timeout configs to nodes
    const nodes = new Map<string, DagNode<T>>();
    for (const [name, node] of this.dagNodes) {
      nodes.set(name, {
        ...node,
        retry: this.dagRetry.get(name),
        timeout: this.dagTimeout.get(name),
      });
    }

    const edges = [...this.dagEdges];
    const merge = this.mergeFn;

    return {
      async invoke(input: T, options?: DagInvokeOptions): Promise<T> {
        return executeDagGraph(nodes, edges, input, options, merge);
      },

      async *stream(input: T, options?: DagInvokeOptions): AsyncGenerator<DagStreamEvent<T>> {
        yield* executeDagGraphStream(nodes, edges, input, options, merge);
      },

      topologicalOrder(): string[] {
        return topologicalSort(nodes, edges);
      },

      dependencies(nodeId: string): string[] {
        const depMap = buildDependencyMap(nodes, edges);
        return depMap.get(nodeId) ?? [];
      },
    };
  }
}
