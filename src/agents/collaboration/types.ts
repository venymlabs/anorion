// Multi-Agent Collaboration Types

// ── Pattern Types ──

export type CollaborationPattern = 'swarm' | 'debate' | 'ensemble' | 'map-reduce' | 'pipeline-chain';

export type AgentRole = 'coordinator' | 'worker' | 'debater' | 'moderator' | 'voter' | 'mapper' | 'reducer';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ── Task ──

export interface CollaborationTask {
  id: string;
  agentId: string;
  agentName: string;
  role: AgentRole;
  prompt: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
  tokensUsed?: number;
}

// ── Blackboard (Shared Context) ──

export interface BlackboardEntry {
  id: string;
  agentId: string;
  key: string;
  value: unknown;
  timestamp: number;
  ttl?: number;
}

// ── Results ──

export interface AgentContribution {
  agentId: string;
  agentName: string;
  role: AgentRole;
  result: string;
  durationMs: number;
  tokensUsed?: number;
}

export interface CollaborationResult {
  content: string;
  pattern: CollaborationPattern;
  agreement?: number;
  contributions: AgentContribution[];
  totalDurationMs: number;
  totalTokens: number;
  iterations: number;
  metadata?: Record<string, unknown>;
}

// ── Cost Tracking ──

export interface AgentCost {
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface CostSummary {
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCalls: number;
  perAgent: Map<string, AgentCost>;
}

// ── Configuration ──

export interface SwarmConfig {
  maxConcurrent: number;
  taskSplitPrompt?: string;
}

export interface DebateConfig {
  rounds: number;
  moderatorPrompt?: string;
}

export interface EnsembleConfig {
  votingStrategy: 'majority' | 'unanimous' | 'weighted' | 'best-of-n';
  agreementThreshold: number;
  weights?: Map<string, number>;
}

export interface MapReduceConfig {
  mapperPrompt?: string;
  reducerPrompt?: string;
  chunks?: string[];
}

export interface PipelineChainConfig {
  onFailure: 'stop' | 'skip' | 'retry';
  maxRetries: number;
}

export interface CollaborationConfig {
  pattern: CollaborationPattern;
  agents: string[];
  coordinator?: string;
  timeoutMs: number;
  maxIterations: number;
  swarm?: SwarmConfig;
  debate?: DebateConfig;
  ensemble?: EnsembleConfig;
  mapReduce?: MapReduceConfig;
  pipelineChain?: PipelineChainConfig;
}

// ── Session ──

export type CollaborationStatus = 'initializing' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CollaborationSession {
  id: string;
  pattern: CollaborationPattern;
  coordinatorAgentId: string;
  tasks: CollaborationTask[];
  blackboard: import('./blackboard').Blackboard;
  status: CollaborationStatus;
  startTime: number;
  endTime?: number;
  config: CollaborationConfig;
  result?: CollaborationResult;
  abortController: AbortController;
}

// ── Metrics ──

export interface CollaborationMetrics {
  sessionId: string;
  pattern: CollaborationPattern;
  totalDurationMs: number;
  totalTokens: number;
  agentCount: number;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  agreementScore?: number;
  agentUtilization: Map<string, number>;
  costPerAgent: Map<string, AgentCost>;
}
