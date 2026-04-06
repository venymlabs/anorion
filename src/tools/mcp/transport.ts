// MCP Transport Layer — stdio and SSE (Server-Sent Events)
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse } from './types';
import { parseMessage, isResponse, serializeMessage } from './json-rpc';
import { logger } from '../../shared/logger';

export interface Transport {
  /** Start/connect the transport */
  start(): Promise<void>;
  /** Send a request and wait for the response */
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** Send a notification (no response expected) */
  notify(notification: JsonRpcNotification): void;
  /** Close the transport */
  close(): void;
  /** Register handler for incoming notifications */
  onNotification(handler: (notification: JsonRpcNotification) => void): void;
  /** Whether the transport is connected */
  connected: boolean;
}

// ── Stdio Transport ──

export class StdioTransport implements Transport {
  connected = false;
  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
  private pending = new Map<string | number, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private buffer = '';
  private reading = false;
  private closed = false;

  constructor(
    private command: string,
    private args: string[] = [],
    private env: Record<string, string> = {},
  ) {}

  async connect(): Promise<void> {
    if (this.proc) return;

    this.proc = Bun.spawn([this.command, ...this.args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...this.env },
    });

    this.connected = true;
    this.closed = false;
    this.startReading();

    logger.debug({ command: this.command }, 'MCP stdio transport connected');
  }

  private startReading(): void {
    if (this.reading || !this.proc) return;
    this.reading = true;

    const reader = this.proc.stdout.getReader();
    this.readLoop(reader).catch((err) => {
      if (!this.closed) {
        logger.error({ error: (err as Error).message }, 'MCP stdio read error');
      }
    });

    // Log stderr for debugging
    this.readStderr().catch(() => {});
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;

      this.buffer += decoder.decode(value, { stream: true });
      this.processBuffer();
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      logger.debug({ stderr: text.trim() }, 'MCP server stderr');
    }
  }

  private processBuffer(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx === -1) break;

      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = parseMessage(line);
        if (isResponse(msg)) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            pending.resolve(msg);
          }
        } else {
          this.notificationHandler?.(msg as JsonRpcNotification);
        }
      } catch (err) {
        logger.warn({ line: line.slice(0, 200), error: (err as Error).message }, 'MCP failed to parse message');
      }
    }
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (!this.proc) {
      throw new Error('Transport not initialized');
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.proc || !this.connected) {
      throw new Error('Transport not connected');
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Request timed out: ${request.method}`));
      }, 30_000);

      this.pending.set(request.id, { resolve, reject, timer });

      const data = serializeMessage(request) + '\n';
      const encoded = new TextEncoder().encode(data);
      try {
        this.proc!.stdin!.write(encoded);
        this.proc!.stdin!.flush();
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(err);
      }
    });
  }

  notify(notification: JsonRpcNotification): void {
    if (!this.proc || !this.connected) return;

    const data = serializeMessage(notification) + '\n';
    const encoded = new TextEncoder().encode(data);
    try {
      this.proc.stdin!.write(encoded);
      this.proc.stdin!.flush();
    } catch (err: unknown) {
      logger.warn({ error: (err as Error).message }, 'MCP failed to send notification');
    }
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Transport closed'));
    }
    this.pending.clear();

    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }
}

// ── SSE Transport ──

export class SseTransport implements Transport {
  connected = false;
  private pending = new Map<string | number, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private notificationHandler: ((notification: JsonRpcNotification) => void) | null = null;
  private messageEndpoint: string | null = null;
  private eventSource: AbortController | null = null;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    return this.connect();
  }

  async connect(): Promise<void> {
    // First, connect to the SSE endpoint to discover the message endpoint
    const sseUrl = new URL('/sse', this.url);

    this.eventSource = new AbortController();

    // Start listening for SSE events to discover the message endpoint
    const response = await fetch(sseUrl.toString(), {
      headers: {
        Accept: 'text/event-stream',
        ...this.headers,
      },
      signal: this.eventSource.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    this.connected = true;

    // Process SSE stream
    this.processSseStream(response).catch((err) => {
      if (this.connected) {
        logger.error({ error: (err as Error).message }, 'MCP SSE stream error');
      }
    });

    // Wait briefly for the endpoint event
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  private async processSseStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let eventData = '';

    while (this.connected) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData += line.slice(5).trim() + '\n';
        } else if (line === '' && eventData) {
          // End of event
          const data = eventData.trim();
          eventData = '';

          if (eventType === 'endpoint') {
            this.messageEndpoint = new URL(data, this.url).toString();
            logger.debug({ endpoint: this.messageEndpoint }, 'MCP SSE message endpoint discovered');
          } else {
            // Regular message
            try {
              const msg = parseMessage(data);
              if (isResponse(msg)) {
                const pending = this.pending.get(msg.id);
                if (pending) {
                  clearTimeout(pending.timer);
                  this.pending.delete(msg.id);
                  pending.resolve(msg);
                }
              } else {
                this.notificationHandler?.(msg as JsonRpcNotification);
              }
            } catch (err) {
              logger.warn({ error: (err as Error).message }, 'MCP failed to parse SSE message');
            }
          }
          eventType = '';
        }
      }
    }
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }

    if (!this.messageEndpoint) {
      throw new Error('Message endpoint not discovered yet');
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Request timed out: ${request.method}`));
      }, 30_000);

      this.pending.set(request.id, { resolve, reject, timer });

      fetch(this.messageEndpoint!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: serializeMessage(request),
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(err);
      });
    });
  }

  notify(notification: JsonRpcNotification): void {
    if (!this.connected || !this.messageEndpoint) return;

    fetch(this.messageEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: serializeMessage(notification),
    }).catch((err) => {
      logger.warn({ error: (err as Error).message }, 'MCP failed to send SSE notification');
    });
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  close(): void {
    this.connected = false;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Transport closed'));
    }
    this.pending.clear();

    this.eventSource?.abort();
    this.eventSource = null;
  }
}
