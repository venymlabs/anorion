// JSON-RPC 2.0 message handling for MCP
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse, JsonRpcError } from './types';
import { JSON_RPC_ERROR_CODES } from './types';

let nextId = 1;

/** Generate a unique JSON-RPC request ID */
export function nextRequestId(): number {
  return nextId++;
}

/** Create a JSON-RPC request */
export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextRequestId(),
    method,
    ...(params !== undefined && { params }),
  };
}

/** Create a JSON-RPC notification (no ID, no response expected) */
export function createNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined && { params }),
  };
}

/** Parse an incoming JSON-RPC message */
export function parseMessage(data: string): JsonRpcResponse | JsonRpcNotification {
  const parsed = JSON.parse(data);
  if (!parsed || parsed.jsonrpc !== '2.0') {
    throw new Error('Invalid JSON-RPC message');
  }
  return parsed;
}

/** Check if a message is a response (has an id and either result or error) */
export function isResponse(msg: JsonRpcResponse | JsonRpcNotification): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

/** Check if a message is a notification (no id) */
export function isNotification(msg: JsonRpcResponse | JsonRpcNotification): msg is JsonRpcNotification {
  return !('id' in msg) || (typeof msg.id !== 'string' && typeof msg.id !== 'number');
}

/** Create a JSON-RPC error */
export function createError(code: number, message: string, data?: unknown): JsonRpcError {
  return { code, message, ...(data !== undefined && { data }) };
}

/** Create a method-not-found error */
export function methodNotFoundError(method: string): JsonRpcError {
  return createError(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

/** Serialize a message for transport */
export function serializeMessage(msg: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(msg);
}
