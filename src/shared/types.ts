// Core types for Anorion

export interface AgentHandoffConfig {
  /** Target agent ID or name */
  targetAgentId: string;
  /** Description of when to hand off (LLM uses this to decide) */
  description: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  fallbackModel?: string;
  systemPrompt: string;
  tools: string[];
  maxIterations?: number;
  timeoutMs?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Agent handoffs — declares which agents this agent can transfer to */
  handoffs?: AgentHandoffConfig[];
}

export type AgentState = 'idle' | 'processing' | 'waiting' | 'error';

export interface Agent extends AgentConfig {
  state: AgentState;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResultEntry[];
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  durationMs?: number;
  createdAt: string;
  priority?: MessagePriority;
}

export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';

export interface MessageEnvelope {
  id: string;
  from: string;
  text: string;
  channelId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ToolResultEntry {
  toolCallId: string;
  toolName: string;
  content: string;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  category?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cacheable?: boolean;
  cacheTtlMs?: number;
}

export interface ToolContext {
  agentId: string;
  sessionId: string;
  signal: AbortSignal;
}

export interface ToolResult {
  content: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;
  agentId: string;
  channelId?: string;
  status: 'active' | 'idle' | 'destroyed';
  tokensUsed: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastActive: string;
}

export interface MemoryEntry {
  id: string;
  agentId: string;
  key: string;
  value: unknown;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  thinkingContent?: string;
}

// ── Streaming types ──

export interface StreamChunk {
  type: 'delta' | 'thinking' | 'tool_call' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResultEntry;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

export type OnChunkCallback = (chunk: StreamChunk) => void;

// ── Error categorization ──

export type ErrorCategory = 'rate_limit' | 'authentication' | 'timeout' | 'model_error' | 'context_length' | 'unknown';

export interface CategorizedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  originalError: Error;
}

// ── Token tracking ──

export interface TokenUsageRecord {
  agentId: string;
  sessionId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: number;
}

export interface AgentRunMetrics {
  agentId: string;
  sessionId: string;
  model: string;
  durationMs: number;
  iterations: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  error?: string;
}
