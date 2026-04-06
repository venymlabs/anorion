import { describe, test, expect } from 'bun:test';
import {
  StateGraph,
  topologicalSort,
  detectCycle,
  createWorkflow,
  sequential,
  parallel,
  conditional,
  mapReduce,
} from '../../src/workflow/index';
import type { CompiledDagGraph } from '../../src/workflow/types';

// ── Helpers ──

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Topological Sort ──

describe('topologicalSort', () => {
  test('sorts a simple linear DAG', () => {
    const graph = new StateGraph<{ v: number }>();
    graph.addNode('a', async (s) => s);
    graph.addNode('b', async (s) => s);
    graph.addNode('c', async (s) => s);
    graph.addEdge('__start__', 'a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'c');
    graph.addEdge('c', '__end__');

    const compiled = graph.compileDag();
    const order = compiled.topologicalOrder();
    expect(order).toContain('a');
    expect(order).toContain('b');
    expect(order).toContain('c');
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  test('sorts a diamond DAG correctly', () => {
    const graph = new StateGraph<{ v: number }>();
    graph.addNode('start', async (s) => s);
    graph.addNode('left', async (s) => s);
    graph.addNode('right', async (s) => s);
    graph.addNode('join', async (s) => s);
    graph.addEdge('__start__', 'start');
    graph.addParallelEdge('start', ['left', 'right']);
    graph.addEdge('left', 'join');
    graph.addEdge('right', 'join');
    graph.addEdge('join', '__end__');

    const compiled = graph.compileDag();
    const order = compiled.topologicalOrder();
    expect(order.indexOf('start')).toBeLessThan(order.indexOf('left'));
    expect(order.indexOf('start')).toBeLessThan(order.indexOf('right'));
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('join'));
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('join'));
  });

  test('throws on cycle detection', () => {
    // Build a cycle manually via dag edges
    const graph = new StateGraph<{ v: number }>();
    graph.addNode('a', async (s) => s);
    graph.addNode('b', async (s) => s);
    graph.addNode('c', async (s) => s);
    graph.addEdge('__start__', 'a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'c');
    graph.addEdge('c', 'a'); // cycle!
    graph.addEdge('c', '__end__');

    expect(() => graph.compileDag()).toThrow(/cycle/i);
  });
});

describe('detectCycle', () => {
  test('returns false for acyclic graph', () => {
    const nodes = new Map<any, any>([
      ['a', { name: 'a', fn: async (s: any) => s }],
      ['b', { name: 'b', fn: async (s: any) => s }],
    ]);
    const edges = [
      { type: 'static' as const, from: 'a', to: 'b' },
    ];
    expect(detectCycle(nodes, edges)).toBe(false);
  });
});

// ── DAG Execution: Sequential ──

describe('DAG sequential execution', () => {
  test('executes nodes in order', async () => {
    const order: string[] = [];
    const graph = new StateGraph<{ steps: string[] }>();
    graph.addNode('step1', async (s) => {
      order.push('step1');
      return { steps: [...s.steps, 'step1'] };
    });
    graph.addNode('step2', async (s) => {
      order.push('step2');
      return { steps: [...s.steps, 'step2'] };
    });
    graph.addNode('step3', async (s) => {
      order.push('step3');
      return { steps: [...s.steps, 'step3'] };
    });
    graph.addEdge('__start__', 'step1');
    graph.addEdge('step1', 'step2');
    graph.addEdge('step2', 'step3');
    graph.addEdge('step3', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({ steps: [] });

    expect(result.steps).toEqual(['step1', 'step2', 'step3']);
    expect(order).toEqual(['step1', 'step2', 'step3']);
  });

  test('passes state through chain', async () => {
    const graph = new StateGraph<{ value: number }>();
    graph.addNode('double', async (s) => ({ value: s.value * 2 }));
    graph.addNode('add10', async (s) => ({ value: s.value + 10 }));
    graph.addNode('halve', async (s) => ({ value: s.value / 2 }));
    graph.addEdge('__start__', 'double');
    graph.addEdge('double', 'add10');
    graph.addEdge('add10', 'halve');
    graph.addEdge('halve', '__end__');

    const compiled = graph.compileDag();
    // 5 * 2 = 10, +10 = 20, /2 = 10
    const result = await compiled.invoke({ value: 5 });
    expect(result.value).toBe(10);
  });
});

// ── DAG Execution: Parallel ──

describe('DAG parallel execution', () => {
  test('executes branches in parallel', async () => {
    const timestamps: Record<string, number> = {};
    const graph = new StateGraph<{ a?: boolean; b?: boolean; c?: boolean }>();
    graph.addNode('start', async (s) => s);
    graph.addNode('branch_a', async (s) => {
      await delay(50);
      timestamps['a'] = Date.now();
      return { a: true };
    });
    graph.addNode('branch_b', async (s) => {
      await delay(50);
      timestamps['b'] = Date.now();
      return { b: true };
    });
    graph.addNode('branch_c', async (s) => {
      await delay(50);
      timestamps['c'] = Date.now();
      return { c: true };
    });
    graph.addNode('join', async (s) => {
      timestamps['join'] = Date.now();
      return { joined: true } as any;
    });
    graph.addEdge('__start__', 'start');
    graph.addFanOutFanIn('start', ['branch_a', 'branch_b', 'branch_c'], 'join');
    graph.addEdge('join', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({});

    expect(result.a).toBe(true);
    expect(result.b).toBe(true);
    expect(result.c).toBe(true);

    // Verify parallelism: all branches should start around the same time
    const times = Object.values(timestamps);
    const maxDiff = Math.max(...times) - Math.min(...times);
    expect(maxDiff).toBeLessThan(200); // Should overlap, not be sequential
  });

  test('parallel edge executes multiple nodes', async () => {
    const graph = new StateGraph<{ x?: number; y?: number }>();
    graph.addNode('source', async (s) => s);
    graph.addNode('compute_x', async (s) => ({ x: 42 }));
    graph.addNode('compute_y', async (s) => ({ y: 99 }));
    graph.addNode('after', async (s) => ({ total: (s.x ?? 0) + (s.y ?? 0) }) as any);
    graph.addEdge('__start__', 'source');
    graph.addParallelEdge('source', ['compute_x', 'compute_y']);
    graph.addEdge('compute_x', 'after');
    graph.addEdge('compute_y', 'after');
    graph.addEdge('after', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({});
    expect(result.x).toBe(42);
    expect(result.y).toBe(99);
  });
});

// ── DAG Execution: Conditional Branching ──

describe('DAG conditional branching', () => {
  test('follows the matching branch', async () => {
    const executed: string[] = [];
    const graph = new StateGraph<{ type: string; result?: string }>();
    graph.addNode('classifier', async (s) => s);
    graph.addNode('handle_a', async (s) => {
      executed.push('handle_a');
      return { result: 'handled_a' };
    });
    graph.addNode('handle_b', async (s) => {
      executed.push('handle_b');
      return { result: 'handled_b' };
    });
    graph.addEdge('__start__', 'classifier');
    graph.addConditionalEdges('classifier', (state) => {
      if (state.type === 'a') return 'handle_a';
      return 'handle_b';
    });
    graph.addEdge('handle_a', '__end__');
    graph.addEdge('handle_b', '__end__');

    const compiled = graph.compileDag();

    const resultA = await compiled.invoke({ type: 'a' });
    expect(resultA.result).toBe('handled_a');
    expect(executed).toContain('handle_a');
    expect(executed).not.toContain('handle_b');

    executed.length = 0;
    const resultB = await compiled.invoke({ type: 'b' });
    expect(resultB.result).toBe('handled_b');
    expect(executed).toContain('handle_b');
    expect(executed).not.toContain('handle_a');
  });

  test('conditional can return multiple targets for parallel execution', async () => {
    const graph = new StateGraph<{ multi?: boolean; a?: boolean; b?: boolean }>();
    graph.addNode('start', async (s) => s);
    graph.addNode('do_a', async (s) => ({ a: true }));
    graph.addNode('do_b', async (s) => ({ b: true }));
    graph.addEdge('__start__', 'start');
    graph.addConditionalEdges('start', (state) => {
      if (state.multi) return ['do_a', 'do_b'];
      return ['do_a'];
    });
    graph.addEdge('do_a', '__end__');
    graph.addEdge('do_b', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({ multi: true });
    expect(result.a).toBe(true);
    expect(result.b).toBe(true);
  });
});

// ── DAG Execution: Loop / Retry ──

describe('DAG loop execution', () => {
  test('loops until condition is false', async () => {
    const graph = new StateGraph<{ count: number; done?: boolean }>();
    graph.addNode('increment', async (s) => ({
      count: s.count + 1,
      done: s.count + 1 >= 5,
    }));
    graph.addEdge('__start__', 'increment');
    graph.addLoopEdge('increment', 'increment', (state) => !state.done, 10);
    graph.addEdge('increment', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({ count: 0 });
    expect(result.count).toBe(5);
    expect(result.done).toBe(true);
  });

  test('respects max iterations', async () => {
    const graph = new StateGraph<{ count: number }>();
    graph.addNode('increment', async (s) => ({
      count: s.count + 1,
    }));
    graph.addEdge('__start__', 'increment');
    graph.addLoopEdge('increment', 'increment', (state) => true, 3); // infinite condition, max 3
    graph.addEdge('increment', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({ count: 0 });
    // 1 initial run + 3 loop-backs = 4 total executions
    expect(result.count).toBe(4);
  });
});

// ── DAG Execution: Fan-out / Fan-in ──

describe('DAG fan-out / fan-in', () => {
  test('fan-out distributes work and fan-in collects results', async () => {
    const graph = new StateGraph<{
      results?: string[];
      r1?: string;
      r2?: string;
      r3?: string;
    }>();
    graph.addNode('scatter', async (s) => s);
    graph.addNode('worker_1', async (s) => ({ r1: 'w1_done' }));
    graph.addNode('worker_2', async (s) => ({ r2: 'w2_done' }));
    graph.addNode('worker_3', async (s) => ({ r3: 'w3_done' }));
    graph.addNode('gather', async (s) => ({
      results: [s.r1, s.r2, s.r3].filter(Boolean) as string[],
    }));
    graph.addEdge('__start__', 'scatter');
    graph.addFanOutFanIn('scatter', ['worker_1', 'worker_2', 'worker_3'], 'gather');
    graph.addEdge('gather', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({});

    expect(result.results).toEqual(['w1_done', 'w2_done', 'w3_done']);
    expect(result.r1).toBe('w1_done');
    expect(result.r2).toBe('w2_done');
    expect(result.r3).toBe('w3_done');
  });
});

// ── DAG Execution: Streaming ──

describe('DAG streaming execution', () => {
  test('yields events in correct order for sequential flow', async () => {
    const graph = new StateGraph<{ val: number }>();
    graph.addNode('a', async (s) => ({ val: s.val + 1 }));
    graph.addNode('b', async (s) => ({ val: s.val + 1 }));
    graph.addEdge('__start__', 'a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', '__end__');

    const compiled = graph.compileDag();
    const events: string[] = [];

    for await (const event of compiled.stream({ val: 0 })) {
      events.push(event.type);
      if (event.nodeId) events.push(event.nodeId);
    }

    expect(events).toEqual([
      'node_start', 'a',
      'node_end', 'a',
      'node_start', 'b',
      'node_end', 'b',
      'done',
    ]);
  });

  test('yields parallel events for fan-out flow', async () => {
    const graph = new StateGraph<{ x?: number; y?: number }>();
    graph.addNode('src', async (s) => s);
    graph.addNode('p1', async (s) => ({ x: 1 }));
    graph.addNode('p2', async (s) => ({ y: 2 }));
    graph.addNode('sink', async (s) => s);
    graph.addEdge('__start__', 'src');
    graph.addFanOutFanIn('src', ['p1', 'p2'], 'sink');
    graph.addEdge('sink', '__end__');

    const compiled = graph.compileDag();
    const events: string[] = [];

    for await (const event of compiled.stream({})) {
      events.push(event.type);
    }

    expect(events).toContain('parallel_start');
    expect(events).toContain('parallel_end');
    expect(events).toContain('fan_in');
    expect(events).toContain('done');
  });

  test('yields loop_iteration events', async () => {
    const graph = new StateGraph<{ i: number }>();
    graph.addNode('tick', async (s) => ({ i: s.i + 1 }));
    graph.addEdge('__start__', 'tick');
    graph.addLoopEdge('tick', 'tick', (s) => s.i < 3, 10);
    graph.addEdge('tick', '__end__');

    const compiled = graph.compileDag();
    const events: string[] = [];

    for await (const event of compiled.stream({ i: 0 })) {
      events.push(event.type);
    }

    const loopEvents = events.filter((e) => e === 'loop_iteration');
    expect(loopEvents.length).toBeGreaterThanOrEqual(2);
    expect(events).toContain('done');
  });
});

// ── DAG Execution: Cancellation ──

describe('DAG cancellation', () => {
  test('respects AbortSignal', async () => {
    const graph = new StateGraph<{ val: number }>();
    graph.addNode('slow', async (s) => {
      await delay(5000);
      return { val: 999 };
    });
    graph.addEdge('__start__', 'slow');
    graph.addEdge('slow', '__end__');

    const compiled = graph.compileDag();
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 50);

    await expect(compiled.invoke({ val: 0 }, { signal: controller.signal })).rejects.toThrow(/abort/i);
  });
});

// ── DAG Execution: Error handling ──

describe('DAG error handling', () => {
  test('abort policy throws on error', async () => {
    const graph = new StateGraph<{ val: number }>();
    graph.addNode('fail', async () => {
      throw new Error('Node failed');
    });
    graph.addEdge('__start__', 'fail');
    graph.addEdge('fail', '__end__');

    const compiled = graph.compileDag();
    await expect(compiled.invoke({ val: 0 }, { onError: 'abort' })).rejects.toThrow('Node failed');
  });

  test('skip policy continues past errors', async () => {
    const graph = new StateGraph<{ val: number; recovered?: boolean }>();
    graph.addNode('fail', async () => {
      throw new Error('Skip me');
    });
    graph.addNode('recover', async (s) => ({ recovered: true }));
    graph.addEdge('__start__', 'fail');
    graph.addEdge('fail', 'recover');
    graph.addEdge('recover', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({ val: 0 }, { onError: 'skip' });
    expect(result.recovered).toBe(true);
  });
});

// ── DAG Execution: Node retry config ──

describe('DAG node retry', () => {
  test('retries failing node according to config', async () => {
    let attempts = 0;
    const graph = new StateGraph<{ done?: boolean }>();
    graph.addNode('flaky', async (s) => {
      attempts++;
      if (attempts < 3) throw new Error('Flaky!');
      return { done: true };
    });
    graph.setRetry('flaky', { maxAttempts: 3, delayMs: 10 });
    graph.addEdge('__start__', 'flaky');
    graph.addEdge('flaky', '__end__');

    const compiled = graph.compileDag();
    const result = await compiled.invoke({});
    expect(result.done).toBe(true);
    expect(attempts).toBe(3);
  });
});

// ── Dependencies API ──

describe('DAG dependencies', () => {
  test('returns correct dependencies', () => {
    const graph = new StateGraph<{ v: number }>();
    graph.addNode('a', async (s) => s);
    graph.addNode('b', async (s) => s);
    graph.addNode('c', async (s) => s);
    graph.addEdge('__start__', 'a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'c');
    graph.addEdge('c', '__end__');

    const compiled = graph.compileDag();
    expect(compiled.dependencies('a')).toEqual([]);
    expect(compiled.dependencies('b')).toEqual(['a']);
    expect(compiled.dependencies('c')).toEqual(['b']);
  });
});

// ── Builder DSL ──

describe('WorkflowBuilder DSL', () => {
  test('builds and executes a simple workflow', async () => {
    const wf = createWorkflow<{ input: string; output?: string }>()
      .start('process')
      .node('process', async (s) => ({ output: `processed: ${s.input}` }))
      .end('process')
      .build();

    const result = await wf.invoke({ input: 'hello' });
    expect(result.output).toBe('processed: hello');
  });

  test('builds a multi-step workflow with connect', async () => {
    const wf = createWorkflow<{ value: number }>()
      .start('step1')
      .node('step1', async (s) => ({ value: s.value + 1 }))
      .connect('step1', 'step2')
      .node('step2', async (s) => ({ value: s.value * 2 }))
      .end('step2')
      .build();

    const result = await wf.invoke({ value: 5 });
    // 5 + 1 = 6, * 2 = 12
    expect(result.value).toBe(12);
  });

  test('builds a workflow with fan-out/fan-in', async () => {
    const wf = createWorkflow<{ x?: number; y?: number; combined?: string }>()
      .start('source')
      .node('source', async (s) => s)
      .fanOut(
        'source',
        [
          { name: 'calc_x', fn: async (s) => ({ x: 10 }) },
          { name: 'calc_y', fn: async (s) => ({ y: 20 }) },
        ],
        'combine',
        async (s) => ({ combined: `${s.x}+${s.y}` }),
      )
      .end('combine')
      .build();

    const result = await wf.invoke({});
    expect(result.combined).toBe('10+20');
  });

  test('builds a workflow with conditional routing', async () => {
    const wf = createWorkflow<{ type: string; handler?: string }>()
      .start('router')
      .node('router', async (s) => s)
      .node('handler_a', async (s) => ({ handler: 'A' }))
      .node('handler_b', async (s) => ({ handler: 'B' }))
      .conditional('router', (s) => s.type === 'a' ? 'handler_a' : 'handler_b')
      .end('handler_a', 'handler_b')
      .build();

    const resultA = await wf.invoke({ type: 'a' });
    expect(resultA.handler).toBe('A');

    const resultB = await wf.invoke({ type: 'b' });
    expect(resultB.handler).toBe('B');
  });

  test('builds a workflow with retry config', async () => {
    let attempts = 0;
    const wf = createWorkflow<{ ok?: boolean }>()
      .start('flaky')
      .node('flaky', async (s) => {
        attempts++;
        if (attempts < 2) throw new Error('fail');
        return { ok: true };
      })
      .retry('flaky', { maxAttempts: 3, delayMs: 10 })
      .end('flaky')
      .build();

    const result = await wf.invoke({});
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test('supports custom merge function', async () => {
    const wf = createWorkflow<{ items: string[] }>()
      .start('split')
      .node('split', async (s) => s)
      .fanOut(
        'split',
        [
          { name: 'p1', fn: async () => ({ items: ['a'] }) },
          { name: 'p2', fn: async () => ({ items: ['b'] }) },
        ],
        'join',
        async (s) => s,
      )
      .merge((results) => {
        const allItems: string[] = [];
        for (const [, partial] of results) {
          if (partial.items) allItems.push(...partial.items);
        }
        return { items: allItems } as any;
      })
      .end('join')
      .build();

    const result = await wf.invoke({ items: [] });
    expect(result.items).toEqual(['a', 'b']);
  });
});

// ── Templates ──

describe('sequential template', () => {
  test('executes steps in order', async () => {
    const wf = sequential<{ val: number }>([
      { name: 'add1', fn: async (s) => ({ val: s.val + 1 }) },
      { name: 'double', fn: async (s) => ({ val: s.val * 2 }) },
      { name: 'sub3', fn: async (s) => ({ val: s.val - 3 }) },
    ]);

    // 5 + 1 = 6, * 2 = 12, - 3 = 9
    const result = await wf.invoke({ val: 5 });
    expect(result.val).toBe(9);
  });

  test('throws on empty steps', () => {
    expect(() => sequential([])).toThrow('at least one step');
  });
});

describe('parallel template', () => {
  test('runs branches in parallel and aggregates', async () => {
    const wf = parallel(
      { name: 'init', fn: async (s) => s },
      [
        { name: 'taskA', fn: async () => ({ a: true }) },
        { name: 'taskB', fn: async () => ({ b: true } as any) },
      ],
      { name: 'collect', fn: async (s) => ({ collected: true } as any) },
    );

    const result = await wf.invoke({} as any) as any;
    expect(result.a).toBe(true);
    expect(result.b).toBe(true);
    expect(result.collected).toBe(true);
  });

  test('throws on single branch', () => {
    expect(() =>
      parallel(
        { name: 'init', fn: async (s) => s },
        [{ name: 'only', fn: async (s) => s }],
        { name: 'end', fn: async (s) => s },
      ),
    ).toThrow('at least 2 branches');
  });
});

describe('conditional template', () => {
  test('routes to matching handler', async () => {
    const wf = conditional(
      { name: 'classify', fn: async (s) => ({ category: 'bug' } as any) },
      [
        {
          name: 'handle_bug',
          condition: (s) => s.category === 'bug',
          fn: async () => ({ handled: 'bug' } as any),
        },
        {
          name: 'handle_feature',
          condition: (s) => s.category === 'feature',
          fn: async () => ({ handled: 'feature' } as any),
        },
      ],
      { name: 'handle_default', fn: async () => ({ handled: 'default' } as any) },
    );

    const result = await wf.invoke({ category: '' } as any);
    expect(result.handled).toBe('bug');
  });

  test('routes to default when no match', async () => {
    const wf = conditional(
      { name: 'classify', fn: async (s) => ({ category: 'unknown' } as any) },
      [
        {
          name: 'handle_bug',
          condition: (s) => s.category === 'bug',
          fn: async () => ({ handled: 'bug' } as any),
        },
      ],
      { name: 'handle_default', fn: async () => ({ handled: 'default' } as any) },
    );

    const result = await wf.invoke({ category: '' } as any);
    expect(result.handled).toBe('default');
  });
});

describe('mapReduce template', () => {
  test('maps across branches and reduces', async () => {
    const wf = mapReduce<{ items: number[]; sum?: number }>({
      mapper: {
        name: 'process',
        fn: async (s) => ({ processed: true } as any),
      },
      branches: 3,
      reducer: {
        name: 'combine',
        fn: async (s) => ({ sum: (s as any).processed ? 42 : 0 } as any),
      },
    });

    const result = await wf.invoke({ items: [1, 2, 3] });
    expect(result.sum).toBe(42);
  });

  test('throws on single branch', () => {
    expect(() =>
      mapReduce({
        mapper: { name: 'm', fn: async (s) => s },
        branches: 1,
        reducer: { name: 'r', fn: async (s) => s },
      }),
    ).toThrow('at least 2 branches');
  });
});

// ── Backward compatibility ──

describe('backward compatibility', () => {
  test('existing compile() still works for linear graphs', async () => {
    const graph = new StateGraph<{ val: number }>();
    graph.addNode('a', async (s) => ({ val: s.val + 1 }));
    graph.addNode('b', async (s) => ({ val: s.val * 2 }));
    graph.addEdge('__start__', 'a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', '__end__');

    const compiled = graph.compile();
    const result = await compiled.invoke({ val: 5 });
    // 5 + 1 = 6, * 2 = 12
    expect(result.val).toBe(12);
  });

  test('existing compile().stream() still works', async () => {
    const graph = new StateGraph<{ val: number }>();
    graph.addNode('a', async (s) => ({ val: s.val + 1 }));
    graph.addEdge('__start__', 'a');
    graph.addEdge('a', '__end__');

    const compiled = graph.compile();
    const events: string[] = [];
    for await (const event of compiled.stream({ val: 0 })) {
      events.push(event.type);
    }
    expect(events).toContain('node_start');
    expect(events).toContain('node_end');
    expect(events).toContain('done');
  });
});
