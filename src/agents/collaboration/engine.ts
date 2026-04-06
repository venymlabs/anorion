// Collaboration Engine — orchestrates multi-agent collaboration sessions
// Manages agent pool, task distribution, result aggregation, shared context, and cost tracking

import { nanoid } from 'nanoid';
import { logger } from '../../shared/logger';
import { eventBus } from '../../shared/events';
import { agentRegistry } from '../registry';
import { Blackboard } from './blackboard';
import { MetricsTracker } from './metrics';
import {
  executeSwarm,
  executeDebate,
  executeEnsemble,
  executeMapReduce,
  executePipelineChain,
} from './patterns';
import type {
  CollaborationConfig,
  CollaborationPattern,
  CollaborationResult,
  CollaborationSession,
  CollaborationMetrics,
  CollaborationTask,
} from './types';

// ── Defaults ──

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_CONCURRENT_SESSIONS = 50;

// ── Pattern Executor Map ──

const patternExecutors: Record<CollaborationPattern, (
  config: CollaborationConfig,
  blackboard: Blackboard,
  signal: AbortSignal,
  metrics: MetricsTracker,
) => Promise<CollaborationResult>> = {
  swarm: executeSwarm,
  debate: executeDebate,
  ensemble: executeEnsemble,
  'map-reduce': executeMapReduce,
  'pipeline-chain': executePipelineChain,
};

// ── Engine ──

export class CollaborationEngine {
  private sessions = new Map<string, CollaborationSession>();

  /** Start a new collaboration session */
  async collaborate(config: CollaborationConfig, input: string): Promise<CollaborationResult> {
    this.validateConfig(config);
    this.enforceSessionLimit();

    const sessionId = nanoid(10);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);

    const blackboard = new Blackboard();
    blackboard.write('system', 'input', input);

    const session: CollaborationSession = {
      id: sessionId,
      pattern: config.pattern,
      coordinatorAgentId: config.coordinator ?? config.agents[0] ?? '',
      tasks: [],
      blackboard,
      status: 'initializing',
      startTime: Date.now(),
      config,
      abortController,
    };

    this.sessions.set(sessionId, session);

    // Link external abort
    const onAbort = () => abortController.abort();

    try {
      session.status = 'running';

      this.emitEvent('started', { sessionId, pattern: config.pattern, agents: config.agents });

      const metrics = new MetricsTracker();
      const executor = patternExecutors[config.pattern];
      if (!executor) throw new Error(`Unknown pattern: ${config.pattern}`);

      const result = await executor(config, blackboard, abortController.signal, metrics);

      session.status = 'completed';
      session.result = result;
      session.endTime = Date.now();

      // Build and emit metrics
      const collabMetrics = metrics.buildMetrics(session);
      this.emitEvent('completed', {
        sessionId,
        pattern: config.pattern,
        durationMs: result.totalDurationMs,
        tokens: result.totalTokens,
        contributions: result.contributions.length,
        agreement: result.agreement,
      });

      logger.info({
        sessionId,
        pattern: config.pattern,
        durationMs: result.totalDurationMs,
        tokens: result.totalTokens,
        agents: config.agents.length,
      }, 'Collaboration completed');

      return result;
    } catch (err) {
      session.status = 'failed';
      session.endTime = Date.now();

      this.emitEvent('failed', {
        sessionId,
        pattern: config.pattern,
        error: (err as Error).message,
      });

      logger.error({
        sessionId,
        pattern: config.pattern,
        error: (err as Error).message,
      }, 'Collaboration failed');

      throw err;
    } finally {
      clearTimeout(timeout);
      // Cleanup session after a delay
      setTimeout(() => this.sessions.delete(sessionId), 60_000);
    }
  }

  /** Cancel a running collaboration */
  cancel(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;

    session.abortController.abort();
    session.status = 'cancelled';
    session.endTime = Date.now();

    this.emitEvent('cancelled', { sessionId, pattern: session.pattern });
    return true;
  }

  /** Get a session by ID */
  getSession(sessionId: string): CollaborationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** List active sessions */
  listSessions(): Array<{ id: string; pattern: CollaborationPattern; status: string; durationMs: number }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      pattern: s.pattern,
      status: s.status,
      durationMs: s.endTime ? s.endTime - s.startTime : Date.now() - s.startTime,
    }));
  }

  /** Get metrics for a session */
  getMetrics(sessionId: string): CollaborationMetrics | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const metrics = new MetricsTracker();
    return metrics.buildMetrics(session);
  }

  /** Validate a collaboration config */
  private validateConfig(config: CollaborationConfig): void {
    if (!config.pattern) throw new Error('Collaboration pattern is required');
    if (!config.agents || config.agents.length === 0) throw new Error('At least one agent is required');

    // Verify agents exist
    for (const agentId of config.agents) {
      const agent = agentRegistry.get(agentId) || agentRegistry.getByName(agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
    }

    // Pattern-specific validation
    if (config.pattern === 'debate' && config.agents.length < 2) {
      throw new Error('Debate pattern requires at least 2 agents');
    }
    if (config.pattern === 'ensemble' && config.agents.length < 2) {
      throw new Error('Ensemble pattern requires at least 2 agents');
    }
    if (config.pattern === 'map-reduce' && config.agents.length < 2) {
      throw new Error('MapReduce pattern requires at least 2 agents');
    }
  }

  private enforceSessionLimit(): void {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      // Clean up completed/failed sessions
      for (const [id, session] of this.sessions) {
        if (session.status !== 'running') {
          this.sessions.delete(id);
        }
      }
      if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
        throw new Error(`Max concurrent collaboration sessions reached (${MAX_CONCURRENT_SESSIONS})`);
      }
    }
  }

  private emitEvent(event: string, data: Record<string, unknown>): void {
    eventBus.emit(`collaboration:${event}`, { ...data, timestamp: Date.now() });
  }
}

// Singleton instance
export const collaborationEngine = new CollaborationEngine();
