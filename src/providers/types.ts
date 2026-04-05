// Provider Normalization Layer — Types
// Unified request/response shapes for all LLM providers

/** A single message in normalized format */
export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
}

export interface NormalizedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface NormalizedTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface NormalizedRequest {
  model: string;
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
  metadata?: Record<string, string>;
}

export interface NormalizedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface NormalizedResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: NormalizedToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }[];
  usage?: NormalizedUsage;
}

// Stream chunk types (OpenAI-compatible SSE format)

export interface StreamChunkDelta {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }[];
}

/** Provider adapter interface — all providers implement this */
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  chatCompletion(req: NormalizedRequest): Promise<NormalizedResponse>;
  chatCompletionStream(req: NormalizedRequest): AsyncIterable<StreamChunkDelta>;
  validateConfig(): boolean;
  listModels(): string[];
}
