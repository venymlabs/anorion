// Workflow Templates — pre-built DAG patterns for common use cases
//
// Templates provide ready-made workflow structures that users can customize.

import type { NodeFunction, CompiledDagGraph, MergeFunction } from './types';
import { StateGraph } from './graph';

// ── Sequential Template ──
// A simple linear chain: step1 → step2 → step3 → ... → done

export interface SequentialStep<T extends Record<string, any>> {
  name: string;
  fn: NodeFunction<T>;
}

/**
 * Build a sequential workflow: steps execute one after another.
 *
 * @example
 * ```ts
 * const wf = sequential([
 *   { name: 'extract', fn: async (s) => ({ extracted: true }) },
 *   { name: 'transform', fn: async (s) => ({ transformed: true }) },
 *   { name: 'load', fn: async (s) => ({ loaded: true }) },
 * ]);
 * const result = await wf.invoke({ data: 'raw' });
 * ```
 */
export function sequential<T extends Record<string, any>>(
  steps: SequentialStep<T>[],
): CompiledDagGraph<T> {
  if (steps.length === 0) throw new Error('Sequential workflow needs at least one step');

  const graph = new StateGraph<T>();

  for (const step of steps) {
    graph.addNode(step.name, step.fn);
  }

  // Chain: START → step0 → step1 → ... → stepN → END
  graph.addEdge('__start__', steps[0]!.name);
  for (let i = 0; i < steps.length - 1; i++) {
    graph.addEdge(steps[i]!.name, steps[i + 1]!.name);
  }
  graph.addEdge(steps[steps.length - 1]!.name, '__end__');

  return graph.compileDag();
}

// ── Parallel Template ──
// Run multiple branches simultaneously, then merge

export interface ParallelBranch<T extends Record<string, any>> {
  name: string;
  fn: NodeFunction<T>;
}

/**
 * Build a parallel workflow: all branches run simultaneously.
 *
 * @example
 * ```ts
 * const wf = parallel(
 *   { name: 'setup', fn: async (s) => ({ ready: true }) },
 *   [
 *     { name: 'taskA', fn: async (s) => ({ a: 'result-a' }) },
 *     { name: 'taskB', fn: async (s) => ({ b: 'result-b' }) },
 *     { name: 'taskC', fn: async (s) => ({ c: 'result-c' }) },
 *   ],
 *   { name: 'aggregate', fn: async (s) => ({ aggregated: true }) },
 * );
 * ```
 */
export function parallel<T extends Record<string, any>>(
  setup: { name: string; fn: NodeFunction<T> },
  branches: ParallelBranch<T>[],
  aggregate: { name: string; fn: NodeFunction<T> },
  mergeFn?: MergeFunction<T>,
): CompiledDagGraph<T> {
  if (branches.length < 2) throw new Error('Parallel workflow needs at least 2 branches');

  const graph = new StateGraph<T>();

  if (mergeFn) graph.setMergeFunction(mergeFn);

  // Setup node
  graph.addNode(setup.name, setup.fn);
  graph.addEdge('__start__', setup.name);

  // Branch nodes
  for (const branch of branches) {
    graph.addNode(branch.name, branch.fn);
  }

  // Aggregate node
  graph.addNode(aggregate.name, aggregate.fn);

  // Fan-out from setup, fan-in to aggregate
  graph.addFanOutFanIn(setup.name, branches.map((b) => b.name), aggregate.name);
  graph.addEdge(aggregate.name, '__end__');

  return graph.compileDag();
}

// ── Conditional Template ──
// Route to different handlers based on state

export interface ConditionalRoute<T extends Record<string, any>> {
  name: string;
  condition: (state: T) => boolean;
  fn: NodeFunction<T>;
}

/**
 * Build a conditional workflow: a classifier decides which handler to run.
 *
 * @example
 * ```ts
 * const wf = conditional(
 *   { name: 'classify', fn: async (s) => ({ category: 'bug' }) },
 *   [
 *     { name: 'handleBug', condition: s => s.category === 'bug', fn: async (s) => ({ handled: 'bug' }) },
 *     { name: 'handleFeature', condition: s => s.category === 'feature', fn: async (s) => ({ handled: 'feature' }) },
 *   ],
 *   { name: 'handleDefault', fn: async (s) => ({ handled: 'default' }) },
 * );
 * ```
 */
export function conditional<T extends Record<string, any>>(
  classifier: { name: string; fn: NodeFunction<T> },
  routes: ConditionalRoute<T>[],
  defaultHandler?: { name: string; fn: NodeFunction<T> },
): CompiledDagGraph<T> {
  if (routes.length === 0) throw new Error('Conditional workflow needs at least one route');

  const graph = new StateGraph<T>();

  // Classifier node
  graph.addNode(classifier.name, classifier.fn);
  graph.addEdge('__start__', classifier.name);

  // Route handler nodes
  for (const route of routes) {
    graph.addNode(route.name, route.fn);
  }

  // Default handler
  const defaultName = defaultHandler?.name;
  if (defaultHandler) {
    graph.addNode(defaultHandler.name, defaultHandler.fn);
  }

  // Conditional edge from classifier
  graph.addConditionalEdges(classifier.name, (state) => {
    for (const route of routes) {
      if (route.condition(state)) return route.name;
    }
    return defaultName ?? '__end__';
  });

  // Connect all handlers to END
  for (const route of routes) {
    graph.addEdge(route.name, '__end__');
  }
  if (defaultHandler) {
    graph.addEdge(defaultHandler.name, '__end__');
  }

  return graph.compileDag();
}

// ── Map-Reduce Template ──
// Fan-out to process items, then reduce results

export interface MapReduceConfig<T extends Record<string, any>> {
  /** Split input into items for parallel processing */
  mapper: {
    name: string;
    fn: NodeFunction<T>;
  };
  /** Number of parallel mapper instances (creates mapper_0, mapper_1, ...) */
  branches: number;
  /** Reduce all mapper results */
  reducer: {
    name: string;
    fn: NodeFunction<T>;
  };
}

/**
 * Build a map-reduce workflow: split work across parallel mappers, then reduce.
 *
 * The mapper function receives state and should process its portion.
 * The reducer receives state with all mapper results merged.
 *
 * @example
 * ```ts
 * const wf = mapReduce({
 *   mapper: { name: 'process', fn: async (s) => ({ processed: true }) },
 *   branches: 4,
 *   reducer: { name: 'combine', fn: async (s) => ({ combined: true }) },
 * });
 * ```
 */
export function mapReduce<T extends Record<string, any>>(
  config: MapReduceConfig<T>,
): CompiledDagGraph<T> {
  if (config.branches < 2) throw new Error('Map-reduce needs at least 2 branches');

  const graph = new StateGraph<T>();

  // Create mapper nodes: mapper_0, mapper_1, ...
  const mapperNames: string[] = [];
  for (let i = 0; i < config.branches; i++) {
    const name = `${config.mapper.name}_${i}`;
    graph.addNode(name, config.mapper.fn);
    mapperNames.push(name);
  }

  // Reducer node
  graph.addNode(config.reducer.name, config.reducer.fn);

  // Fan-out from START → all mappers → fan-in to reducer → END
  graph.addFanOutFanIn('__start__', mapperNames, config.reducer.name);
  graph.addEdge(config.reducer.name, '__end__');

  return graph.compileDag();
}
