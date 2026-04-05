// Types matching the Anorion gateway API

export type AgentState = "idle" | "processing" | "waiting" | "error";

export interface Agent {
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
  state: AgentState;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
  maxIterations?: number;
  timeoutMs?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type UpdateAgentInput = Partial<CreateAgentInput>;

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
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultEntry {
  toolCallId: string;
  result: unknown;
  error?: string;
}

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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  category?: string;
  timeoutMs?: number;
}

export interface Channel {
  name: string;
  type: string;
  enabled: boolean;
  status: "running" | "stopped" | "error";
  config?: Record<string, unknown>;
}

export interface MemoryEntry {
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsed?: string;
}

export interface SystemStats {
  agents: { total: number; active: number };
  sessions: { total: number; active: number };
  tokens: { used: number; budget: number };
  tools: number;
  uptime: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  agentId?: string;
  sessionId?: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface TokenUsage {
  date: string;
  tokensIn: number;
  tokensOut: number;
  total: number;
}

// SSE stream events
export type StreamEventType =
  | "token"
  | "tool_call"
  | "tool_result"
  | "done"
  | "error";

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
}

export interface ChatResponse {
  message: Message;
  session: { id: string };
}

// WebSocket events
export type WSEventType =
  | "agent:processing"
  | "agent:tool-call"
  | "agent:response"
  | "agent:error"
  | "agent:idle";

export interface WSMessage {
  type: WSEventType;
  agentId: string;
  data?: unknown;
}
