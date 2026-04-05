// ── Agent ──

export interface AgentHandoffConfig {
  targetAgentId: string;
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
  handoffs?: AgentHandoffConfig[];
}

export type AgentState = "idle" | "processing" | "waiting" | "error";

export interface Agent extends AgentConfig {
  state: AgentState;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCreateParams {
  name: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
  fallbackModel?: string;
  maxIterations?: number;
  timeoutMs?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  handoffs?: AgentHandoffConfig[];
}

export interface AgentUpdateParams {
  name?: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  fallbackModel?: string;
  maxIterations?: number;
  timeoutMs?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  handoffs?: AgentHandoffConfig[];
}

// ── Session ──

export interface Session {
  id: string;
  agentId: string;
  channelId?: string;
  status: "active" | "idle" | "destroyed";
  tokensUsed: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastActive: string;
}

export interface SessionListParams {
  agentId?: string;
  status?: Session["status"];
  limit?: number;
  offset?: number;
}

// ── Message ──

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultEntry {
  toolCallId: string;
  toolName: string;
  content: string;
  error?: string;
}

export type MessagePriority = "critical" | "high" | "normal" | "low";

export interface Message {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant" | "system" | "tool";
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

export interface MessageListParams {
  limit?: number;
  offset?: number;
  role?: Message["role"];
}

// ── Streaming ──

export interface StreamChunk {
  type: "delta" | "thinking" | "tool_call" | "tool_result" | "done" | "error";
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResultEntry;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

export interface ChatOptions {
  sessionId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
}

// ── Tool ──

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category?: string;
}

export interface ToolExecuteParams {
  [key: string]: unknown;
}

export interface ToolExecuteResult {
  content: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ── Channel ──

export interface Channel {
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

// ── Config ──

export interface ConfigEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

// ── Trace ──

export interface Trace {
  id: string;
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
  createdAt: string;
}

export interface TraceListParams {
  agentId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

// ── Search ──

export interface SearchFilters {
  agentId?: string;
  sessionId?: string;
  role?: Message["role"];
  startDate?: string;
  endDate?: string;
}

export interface SearchResult {
  message: Message;
  score: number;
}

// ── Health ──

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  version: string;
  uptime: number;
  checks?: Record<string, { status: "ok" | "fail"; latencyMs?: number }>;
}

// ── API envelope ──

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    limit?: number;
    offset?: number;
  };
}

// ── WebSocket events ──

export type WsEventType =
  | "agent:state"
  | "session:message"
  | "session:created"
  | "session:destroyed"
  | "chat:delta"
  | "chat:done"
  | "chat:error"
  | "tool:execute"
  | "tool:result";

export interface WsEvent<T = unknown> {
  type: WsEventType;
  data: T;
  timestamp: number;
}
