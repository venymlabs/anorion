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
} from './types';
import { executeGraph, executeGraphStream } from './executor';
import { START, END } from './types';

export class StateGraph<T extends Record<string, any> = Record<string, any>> {
  private nodes = new Map<string, GraphNode<T>>();
  private edges: EdgeDef<T>[] = [];

  addNode(name: string, fn: NodeFunction<T>): this {
    if (name === START || name === END) {
      throw new Error(`Cannot add node with reserved name: ${name}`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`Node already exists: ${name}`);
    }
    this.nodes.set(name, { name, fn });
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.push({ type: 'static', from, to });
    return this;
  }

  addConditionalEdges(from: string, condition: ConditionFn<T>): this {
    this.edges.push({ type: 'conditional', from, condition });
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
}
