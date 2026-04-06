// Collaboration Patterns: Swarm, Debate, Ensemble, MapReduce, PipelineChain
// Each pattern implements a specific multi-agent coordination strategy

import { nanoid } from 'nanoid';
import { sendMessage } from '../runtime';
import { agentRegistry } from '../registry';
import { logger } from '../../shared/logger';
import type { Blackboard } from './blackboard';
import { MetricsTracker } from './metrics';
import type {
  CollaborationConfig,
  CollaborationResult,
  CollaborationTask,
  AgentContribution,
  AgentRole,
} from './types';

// ── Helpers ──

function resolveAgent(idOrName: string) {
  return agentRegistry.get(idOrName) || agentRegistry.getByName(idOrName);
}

function getInput(blackboard: Blackboard): string {
  return String(blackboard.read('input')?.value ?? '');
}

async function runAgent(
  agentId: string,
  prompt: string,
  signal: AbortSignal,
  metrics: MetricsTracker,
): Promise<{ content: string; tokens: number; durationMs: number }> {
  const start = Date.now();
  const result = await sendMessage({
    agentId,
    text: prompt,
    abortSignal: signal,
  });
  const durationMs = Date.now() - start;

  const tokens = result.usage?.totalTokens ?? 0;
  metrics.recordTokens(agentId, result.usage?.promptTokens ?? 0, result.usage?.completionTokens ?? 0);
  metrics.recordUtilization(agentId, durationMs);

  return { content: result.content, tokens, durationMs };
}

// ── Swarm Pattern ──
// Coordinator splits task into subtasks, workers execute in parallel, coordinator aggregates

export async function executeSwarm(
  config: CollaborationConfig,
  blackboard: Blackboard,
  signal: AbortSignal,
  metrics: MetricsTracker,
): Promise<CollaborationResult> {
  const coordinatorId = config.coordinator ?? config.agents[0];
  if (!coordinatorId) throw new Error('Swarm requires a coordinator agent');
  const maxConcurrent = config.swarm?.maxConcurrent ?? 5;
  const startTime = Date.now();
  const input = getInput(blackboard);

  const coordinator = resolveAgent(coordinatorId);
  if (!coordinator) throw new Error(`Coordinator agent not found: ${coordinatorId}`);

  // Phase 1: Coordinator splits the task
  const splitPrompt = config.swarm?.taskSplitPrompt ?? 'Split the following task into independent subtasks that can be worked on in parallel. Return a JSON array of objects with "id" and "description" fields.';
  const workerAgents = config.agents.filter((a) => a !== coordinatorId);

  if (workerAgents.length === 0) throw new Error('Swarm requires at least one worker agent');

  const splitResult = await runAgent(
    coordinatorId,
    `${splitPrompt}\n\nAvailable workers: ${workerAgents.length}\nTask: ${input}`,
    signal,
    metrics,
  );

  // Parse subtasks
  let subtasks: Array<{ id: string; description: string }> = [];
  try {
    const match = splitResult.content.match(/\[[\s\S]*\]/);
    if (match) subtasks = JSON.parse(match[0]);
  } catch {
    subtasks = workerAgents.map((_, i) => ({ id: `task-${i}`, description: input }));
  }

  if (subtasks.length === 0) {
    subtasks = [{ id: 'task-0', description: input }];
  }

  logger.info({ subtasks: subtasks.length, workers: workerAgents.length }, 'Swarm: tasks split');

  // Phase 2: Workers execute subtasks in parallel (batched)
  const tasks: CollaborationTask[] = [];
  const contributions: AgentContribution[] = [];

  for (let i = 0; i < subtasks.length; i += maxConcurrent) {
    if (signal.aborted) break;

    const batch = subtasks.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(async (subtask, batchIdx) => {
      const workerIdx = (i + batchIdx) % workerAgents.length;
      const workerId = workerAgents[workerIdx]!;
      const worker = resolveAgent(workerId);

      const task: CollaborationTask = {
        id: nanoid(8),
        agentId: workerId,
        agentName: worker?.name ?? workerId,
        role: 'worker',
        prompt: subtask.description,
        status: 'running',
        startTime: Date.now(),
      };
      tasks.push(task);

      try {
        const context = blackboard.buildSummary(['input']);
        const result = await runAgent(
          workerId,
          `[Context]\n${context}\n\n[Your task]\n${subtask.description}\n\nReturn your result concisely.`,
          signal,
          metrics,
        );

        task.status = 'completed';
        task.result = result.content;
        task.durationMs = result.durationMs;
        task.tokensUsed = result.tokens;
        task.endTime = Date.now();

        blackboard.write(workerId, `result:${subtask.id}`, result.content);

        contributions.push({
          agentId: workerId,
          agentName: worker?.name ?? workerId,
          role: 'worker',
          result: result.content,
          durationMs: result.durationMs,
          tokensUsed: result.tokens,
        });
      } catch (err) {
        task.status = 'failed';
        task.error = (err as Error).message;
        task.endTime = Date.now();
      }
    });

    await Promise.all(batchPromises);
  }

  // Phase 3: Coordinator aggregates results
  const allResults = blackboard.readAll('result');
  const aggregatePrompt = `Synthesize the following worker results into a coherent final answer:\n\n${allResults.map((e, i) => `Worker ${i + 1} (${e.agentId}):\n${JSON.stringify(e.value)}`).join('\n\n---\n\n')}`;

  const aggregateResult = await runAgent(coordinatorId, aggregatePrompt, signal, metrics);

  const totalTokens = contributions.reduce((sum, c) => sum + (c.tokensUsed ?? 0), 0) + aggregateResult.tokens;

  return {
    content: aggregateResult.content,
    pattern: 'swarm',
    contributions: [
      ...contributions,
      {
        agentId: coordinatorId,
        agentName: coordinator.name,
        role: 'coordinator',
        result: aggregateResult.content,
        durationMs: aggregateResult.durationMs,
        tokensUsed: aggregateResult.tokens,
      },
    ],
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    iterations: 1,
    metadata: { subtaskCount: subtasks.length, workerCount: workerAgents.length },
  };
}

// ── Debate Pattern ──
// Agents argue opposing viewpoints across rounds, moderator synthesizes consensus

export async function executeDebate(
  config: CollaborationConfig,
  blackboard: Blackboard,
  signal: AbortSignal,
  metrics: MetricsTracker,
): Promise<CollaborationResult> {
  const rounds = config.debate?.rounds ?? 3;
  const startTime = Date.now();
  const topic = getInput(blackboard);

  if (config.agents.length < 2) throw new Error('Debate requires at least 2 agents');

  const moderatorId = config.coordinator ?? config.agents[0];
  if (!moderatorId) throw new Error('Debate requires a moderator agent');
  const debaterIds = config.agents.filter((a) => a !== moderatorId);

  if (debaterIds.length === 0) throw new Error('Debate requires at least 1 debater (plus moderator)');

  const contributions: AgentContribution[] = [];
  let roundResults: string[] = [];

  for (let round = 0; round < rounds; round++) {
    if (signal.aborted) break;

    logger.info({ round: round + 1, rounds }, 'Debate round');

    const debaterPromises = debaterIds.map(async (debaterId, idx) => {
      const debater = resolveAgent(debaterId);
      const stance = idx === 0 ? 'FOR' : idx === 1 ? 'AGAINST' : `PERSPECTIVE ${idx}`;
      const previousContext = roundResults.length > 0
        ? `\n\n[Previous round arguments]\n${roundResults.join('\n---\n')}`
        : '';

      const prompt = `You are a debater arguing ${stance} the following topic. Present your strongest arguments.${previousContext}\n\nTopic: ${topic}\n\nProvide your argument clearly and concisely.`;

      const result = await runAgent(debaterId, prompt, signal, metrics);
      blackboard.write(debaterId, `debate:round-${round}`, result.content);

      contributions.push({
        agentId: debaterId,
        agentName: debater?.name ?? debaterId,
        role: 'debater',
        result: result.content,
        durationMs: result.durationMs,
        tokensUsed: result.tokens,
      });

      return `[${stance}] ${result.content}`;
    });

    roundResults = await Promise.all(debaterPromises);
  }

  // Moderator synthesizes
  const moderator = resolveAgent(moderatorId);
  const allArgs = blackboard.getAll()
    .filter((e) => e.key.startsWith('debate:'))
    .map((e) => `[${e.agentId}]: ${JSON.stringify(e.value)}`)
    .join('\n\n');

  const synthPrompt = config.debate?.moderatorPrompt ?? 'You are a debate moderator. Synthesize the arguments below into a balanced conclusion that captures the strongest points from all sides.';

  const synthResult = await runAgent(
    moderatorId,
    `${synthPrompt}\n\nTopic: ${topic}\n\nArguments:\n${allArgs}\n\nProvide a balanced synthesis.`,
    signal,
    metrics,
  );

  const totalTokens = contributions.reduce((sum, c) => sum + (c.tokensUsed ?? 0), 0) + synthResult.tokens;

  return {
    content: synthResult.content,
    pattern: 'debate',
    contributions: [
      ...contributions,
      {
        agentId: moderatorId,
        agentName: moderator?.name ?? moderatorId,
        role: 'moderator',
        result: synthResult.content,
        durationMs: synthResult.durationMs,
        tokensUsed: synthResult.tokens,
      },
    ],
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    iterations: rounds,
    metadata: { rounds, debaterCount: debaterIds.length },
  };
}

// ── Ensemble Pattern ──
// Multiple agents solve the same task independently, votes/averages on best answer

export async function executeEnsemble(
  config: CollaborationConfig,
  blackboard: Blackboard,
  signal: AbortSignal,
  metrics: MetricsTracker,
): Promise<CollaborationResult> {
  const strategy = config.ensemble?.votingStrategy ?? 'majority';
  const threshold = config.ensemble?.agreementThreshold ?? 0.6;
  const startTime = Date.now();
  const task = getInput(blackboard);

  if (config.agents.length < 2) throw new Error('Ensemble requires at least 2 agents');

  // Phase 1: All agents solve independently in parallel
  const results = await Promise.all(
    config.agents.map(async (agentId) => {
      const agent = resolveAgent(agentId);
      const result = await runAgent(
        agentId,
        `Solve the following task independently. Provide your best answer.\n\nTask: ${task}`,
        signal,
        metrics,
      );

      blackboard.write(agentId, 'ensemble:answer', result.content);

      return {
        agentId,
        agentName: agent?.name ?? agentId,
        content: result.content,
        tokens: result.tokens,
        durationMs: result.durationMs,
      };
    }),
  );

  logger.info({ agentCount: results.length }, 'Ensemble: all agents responded');

  // Phase 2: Aggregate based on strategy
  let finalContent: string;
  let agreement: number;
  const coordinatorId = config.coordinator ?? config.agents[0];
  if (!coordinatorId) throw new Error('Ensemble requires a coordinator agent');

  switch (strategy) {
    case 'majority': {
      const allAnswers = results.map((r) => `Agent ${r.agentName}:\n${r.content}`).join('\n\n---\n\n');
      const pickResult = await runAgent(
        coordinatorId,
        `Multiple agents have answered the same question. Select the best answer or synthesize the most accurate response based on majority agreement.\n\nQuestion: ${task}\n\nAnswers:\n${allAnswers}\n\nProvide the best synthesized answer.`,
        signal,
        metrics,
      );
      finalContent = pickResult.content;
      agreement = results.length > 1 ? 0.7 : 1.0;
      break;
    }
    case 'best-of-n': {
      const allAnswers = results.map((r, i) => `[Answer ${i + 1} from ${r.agentName}]\n${r.content}`).join('\n\n');
      const rankResult = await runAgent(
        coordinatorId,
        `Rank these answers from best to worst. Then return ONLY the best answer verbatim.\n\nQuestion: ${task}\n\n${allAnswers}`,
        signal,
        metrics,
      );
      finalContent = rankResult.content;
      agreement = 1.0;
      break;
    }
    case 'weighted': {
      const weights = config.ensemble?.weights;
      let bestAgent = results[0];
      if (weights) {
        let bestWeight = 0;
        for (const r of results) {
          const w = weights.get(r.agentId) ?? 1;
          if (w > bestWeight) {
            bestWeight = w;
            bestAgent = r;
          }
        }
      }
      finalContent = bestAgent!.content;
      agreement = 1.0;
      break;
    }
    case 'unanimous':
    default: {
      const allAnswers = results.map((r) => `Agent ${r.agentName}:\n${r.content}`).join('\n\n---\n\n');
      const mergeResult = await runAgent(
        coordinatorId,
        `Merge these answers into a single answer that all agents would agree on. Resolve any contradictions.\n\nQuestion: ${task}\n\nAnswers:\n${allAnswers}`,
        signal,
        metrics,
      );
      finalContent = mergeResult.content;
      agreement = threshold;
      break;
    }
  }

  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  const contributions: AgentContribution[] = results.map((r) => ({
    agentId: r.agentId,
    agentName: r.agentName,
    role: 'voter',
    result: r.content,
    durationMs: r.durationMs,
    tokensUsed: r.tokens,
  }));

  return {
    content: finalContent,
    pattern: 'ensemble',
    agreement,
    contributions,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    iterations: 1,
    metadata: { strategy, agentCount: config.agents.length },
  };
}

// ── MapReduce Pattern ──
// Distribute work across mapper agents, reducer agent aggregates

export async function executeMapReduce(
  config: CollaborationConfig,
  blackboard: Blackboard,
  signal: AbortSignal,
  metrics: MetricsTracker,
): Promise<CollaborationResult> {
  const startTime = Date.now();
  const input = getInput(blackboard);

  const chunks = config.mapReduce?.chunks ?? splitIntoChunks(input, config.agents.length);
  const mapperIds = config.agents.slice(0, -1);
  const reducerId = config.agents[config.agents.length - 1]!;

  if (mapperIds.length === 0) throw new Error('MapReduce requires at least 2 agents (mappers + reducer)');

  const mapperPrompt = config.mapReduce?.mapperPrompt ?? 'Process the following chunk and extract key information.';

  // Phase 1: Map
  const mapResults = await Promise.all(
    chunks.map(async (chunk, idx) => {
      const mapperId = mapperIds[idx % mapperIds.length]!;
      const mapper = resolveAgent(mapperId);

      const result = await runAgent(
        mapperId,
        `${mapperPrompt}\n\n[Chunk ${idx + 1}/${chunks.length}]\n${chunk}`,
        signal,
        metrics,
      );

      blackboard.write(mapperId, `map:chunk-${idx}`, result.content);

      return {
        agentId: mapperId,
        agentName: mapper?.name ?? mapperId,
        role: 'mapper' as AgentRole,
        content: result.content,
        tokens: result.tokens,
        durationMs: result.durationMs,
        chunkIdx: idx,
      };
    }),
  );

  logger.info({ mapperCount: mapperIds.length, chunkCount: chunks.length }, 'MapReduce: map phase complete');

  // Phase 2: Reduce
  const reducer = resolveAgent(reducerId);
  const reducerPrompt = config.mapReduce?.reducerPrompt ?? 'Combine and synthesize the following mapped results into a coherent final output.';

  const mappedOutputs = mapResults.map((r) => `[Mapper ${r.agentName}, chunk ${r.chunkIdx + 1}]\n${r.content}`).join('\n\n---\n\n');

  const reduceResult = await runAgent(
    reducerId,
    `${reducerPrompt}\n\n[Mapped results]\n${mappedOutputs}`,
    signal,
    metrics,
  );

  const totalTokens = mapResults.reduce((sum, r) => sum + r.tokens, 0) + reduceResult.tokens;
  const contributions: AgentContribution[] = [
    ...mapResults.map((r) => ({
      agentId: r.agentId,
      agentName: r.agentName,
      role: 'mapper' as AgentRole,
      result: r.content,
      durationMs: r.durationMs,
      tokensUsed: r.tokens,
    })),
    {
      agentId: reducerId,
      agentName: reducer?.name ?? reducerId,
      role: 'reducer',
      result: reduceResult.content,
      durationMs: reduceResult.durationMs,
      tokensUsed: reduceResult.tokens,
    },
  ];

  return {
    content: reduceResult.content,
    pattern: 'map-reduce',
    contributions,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    iterations: 1,
    metadata: { chunkCount: chunks.length, mapperCount: mapperIds.length },
  };
}

// ── PipelineChain Pattern ──
// Sequential agent handoffs with context passing

export async function executePipelineChain(
  config: CollaborationConfig,
  blackboard: Blackboard,
  signal: AbortSignal,
  metrics: MetricsTracker,
): Promise<CollaborationResult> {
  const startTime = Date.now();
  const onFailure = config.pipelineChain?.onFailure ?? 'stop';
  const maxRetries = config.pipelineChain?.maxRetries ?? 1;
  let currentInput = getInput(blackboard);
  const contributions: AgentContribution[] = [];
  let iteration = 0;

  for (const agentId of config.agents) {
    if (signal.aborted) break;

    const agent = resolveAgent(agentId);
    if (!agent) {
      if (onFailure === 'stop') throw new Error(`Agent not found: ${agentId}`);
      continue;
    }

    let result: { content: string; tokens: number; durationMs: number } | null = null;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const context = blackboard.buildSummary();
        const prompt = `[Pipeline context]\n${context}\n\n[Current task]\n${currentInput}`;

        result = await runAgent(agentId, prompt, signal, metrics);
        break;
      } catch (err) {
        lastError = (err as Error).message;
        if (onFailure === 'skip') break;
        if (attempt < maxRetries) {
          logger.warn({ agentId, attempt, error: lastError }, 'Pipeline step failed, retrying');
        }
      }
    }

    iteration++;

    if (result) {
      blackboard.write(agentId, `pipeline:step-${iteration}`, result.content);
      currentInput = result.content;

      contributions.push({
        agentId,
        agentName: agent.name,
        role: 'worker',
        result: result.content,
        durationMs: result.durationMs,
        tokensUsed: result.tokens,
      });
    } else if (onFailure === 'stop') {
      throw new Error(`Pipeline failed at step ${iteration}: ${lastError}`);
    }
  }

  const totalTokens = contributions.reduce((sum, c) => sum + (c.tokensUsed ?? 0), 0);

  return {
    content: currentInput,
    pattern: 'pipeline-chain',
    contributions,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    iterations: iteration,
  };
}

// ── Chunking helper ──

function splitIntoChunks(text: string, count: number): string[] {
  if (count <= 1) return [text];

  const chunkSize = Math.ceil(text.length / count);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks.length > 0 ? chunks : [text];
}
