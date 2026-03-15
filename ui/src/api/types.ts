// API types matching the backend spec

export type AgentStatus = 'active' | 'idle' | 'suspended' | 'error' | 'shutting_down'

export interface AgentSummary {
  id: string
  name: string
  status: AgentStatus
  model: string
  activeSessions: number
  tokensToday: number
  lastActive: string
  tags?: string[]
}

export interface Agent extends AgentSummary {
  config: AgentConfig
  metrics: AgentMetrics
  tools: string[]
  skills: string[]
}

export interface AgentConfig {
  name: string
  model: {
    model: string
    fallbacks?: { model: string; retryOn?: number[] }[]
    params?: { temperature?: number; maxTokens?: number }
  }
  tools?: string[]
  skills?: string[]
  memory?: {
    shortTerm?: { maxMessages: number }
    longTerm?: { directory: string; provider?: string }
  }
  permissions?: { allow?: string[]; deny?: string[] }
  maxIterations?: number
  timeoutMs?: number
}

export interface AgentMetrics {
  totalTokens: number
  tokensToday: number
  totalMessages: number
  uptime: number
  tokenBudget?: number
}

export type SessionStatus = 'active' | 'idle' | 'completed' | 'error'

export interface SessionSummary {
  id: string
  agentId: string
  agentName?: string
  status: SessionStatus
  messageCount: number
  tokens: number
  createdAt: string
  lastActive: string
}

export interface Session extends SessionSummary {
  messages: Message[]
  toolCalls: ToolCall[]
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tokens?: number
  timestamp: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  output?: unknown
  durationMs?: number
  status: 'started' | 'success' | 'error'
  error?: string
}

export interface ToolSummary {
  name: string
  description: string
  category: string
  boundAgents: string[]
  timeoutMs?: number
}

export interface Tool extends ToolSummary {
  schema: Record<string, unknown>
  permissions: string[]
}

export interface CronJob {
  id: string
  name: string
  agentId: string
  agentName?: string
  schedule: string
  enabled: boolean
  status: 'idle' | 'running' | 'error'
  lastRun?: string
  nextRun?: string
  task: { type: string; text?: string }
}

export interface GatewayStatus {
  id: string
  uptime: number
  version: string
  agentCount: number
  activeSessions: number
  status: 'healthy' | 'degraded' | 'down'
  cpu?: number
  memory?: number
  errors1h?: number
}

export interface ActivityEvent {
  id: string
  timestamp: string
  type: 'message' | 'tool_call' | 'status_change' | 'error' | 'cron' | 'spawn'
  agentId?: string
  agentName?: string
  description: string
  metadata?: Record<string, unknown>
}

export interface ApiKey {
  id: string
  name: string
  scopes: string[]
  agentId?: string
  createdAt: string
  lastUsed?: string
  key?: string // only on creation
}

// WS event types
export interface WSEvent {
  type: string
  [key: string]: unknown
}
