// Core types for Anorion

export interface AgentHandoffConfig {
  /** Target agent ID or name */
  targetAgentId: string;
  /** Description of when to hand off (LLM uses this to decide) */
  description: string;
}

export interface AgentCollaborationConfig {
  /** Collaboration patterns this agent can participate in */
  patterns?: string[];
  /** Default role in collaborations */
  defaultRole?: 'coordinator' | 'worker' | 'debater' | 'moderator' | 'voter' | 'mapper' | 'reducer';
  /** Weight for ensemble voting (higher = more influence) */
  votingWeight?: number;
  /** Whether this agent has collaboration tools enabled */
  toolsEnabled?: boolean;
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
  /** Multi-agent collaboration configuration */
  collaboration?: AgentCollaborationConfig;
  /** Voice configuration for this agent */
  voice?: VoiceConfig;
}

export interface VoiceConfig {
  enabled?: boolean;
  ttsProvider?: 'edge-tts' | 'openai' | 'elevenlabs';
  sttProvider?: 'openai-whisper' | 'web-speech';
  voice?: string;
  language?: string;
  speed?: number;
  pitch?: number;
  outputFormat?: 'mp3' | 'ogg' | 'wav' | 'webm';
  conversationMode?: boolean;
  conversationSilenceMs?: number;
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

/** Per-channel streaming configuration */
export interface StreamingConfig {
  /** Enable token-by-token streaming for this channel */
  enabled: boolean;
  /** Minimum characters accumulated before sending an update (default: 15) */
  minDeltaChars: number;
  /** Minimum ms between edit API calls to avoid rate limits (default: 800) */
  updateIntervalMs: number;
  /** Maximum ms to buffer before forcing a flush (default: 2000) */
  maxBufferMs: number;
  /** Initial placeholder text when starting a streaming message (default: "…") */
  initialText: string;
  /** Whether to show typing indicators during streaming (default: true) */
  showTyping: boolean;
}

export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  enabled: true,
  minDeltaChars: 15,
  updateIntervalMs: 800,
  maxBufferMs: 2000,
  initialText: '…',
  showTyping: true,
};

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
