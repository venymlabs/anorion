// Client
export { AnorionClient } from "./client.js";
export type { AnorionClientOptions } from "./client.js";

// Errors
export {
  AnorionError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ValidationError,
} from "./errors.js";

// Streaming
export { parseSSEStream } from "./streaming.js";

// WebSocket
export { WebSocketClient } from "./websocket.js";
export type { WebSocketClientOptions } from "./websocket.js";

// Types
export type {
  Agent,
  AgentConfig,
  AgentCreateParams,
  AgentUpdateParams,
  AgentHandoffConfig,
  AgentState,
  Session,
  SessionListParams,
  Message,
  MessageListParams,
  MessagePriority,
  ToolCall,
  ToolResultEntry,
  StreamChunk,
  ChatOptions,
  ToolInfo,
  ToolExecuteParams,
  ToolExecuteResult,
  Channel,
  ConfigEntry,
  Trace,
  TraceListParams,
  SearchFilters,
  SearchResult,
  HealthStatus,
  ApiResponse,
  WsEventType,
  WsEvent,
} from "./types.js";
