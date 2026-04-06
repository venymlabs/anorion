// Multi-Agent Collaboration — Public API
// Swarm, Debate, Ensemble, MapReduce, PipelineChain patterns

export { CollaborationEngine, collaborationEngine } from './engine';
export { Blackboard } from './blackboard';
export { MetricsTracker } from './metrics';
export { collaborationTools } from './tools';

export type {
  CollaborationPattern,
  AgentRole,
  TaskStatus,
  CollaborationTask,
  BlackboardEntry,
  AgentContribution,
  CollaborationResult,
  AgentCost,
  CostSummary,
  SwarmConfig,
  DebateConfig,
  EnsembleConfig,
  MapReduceConfig,
  PipelineChainConfig,
  CollaborationConfig,
  CollaborationStatus,
  CollaborationSession,
  CollaborationMetrics,
} from './types';
