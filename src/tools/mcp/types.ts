// MCP (Model Context Protocol) types
// Based on the Model Context Protocol specification

// ── JSON-RPC 2.0 ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ── MCP Protocol Types ──

export interface Implementation {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  roots?: { listChanged?: boolean };
  sampling?: {};
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: {};
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
}

// ── MCP Tools ──

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: McpResourceContents };

// ── MCP Resources ──

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ── MCP Prompts ──

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpContent;
}

export interface GetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

// ── Transport Config ──

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

export interface McpServerConfig {
  /** Unique name for this MCP server */
  name: string;
  /** Transport configuration */
  transport: McpTransportConfig;
  /** Connection timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Whether to auto-reconnect on failure (default: true) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts before giving up (default: 5) */
  maxReconnectAttempts?: number;
  /** Tool call timeout in ms (default: 30000) */
  toolTimeoutMs?: number;
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;
}

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
