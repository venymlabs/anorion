import type { WsEvent, WsEventType } from "./types.js";

type Handler<T = unknown> = (event: WsEvent<T>) => void;

export interface WebSocketClientOptions {
  /** WebSocket URL, e.g. ws://localhost:3000/ws */
  url: string;
  /** Auth token (sent as query param or first message) */
  token?: string;
  /** Reconnect delay base in ms (default 1000) */
  reconnectDelayMs?: number;
  /** Max reconnect attempts (default 10) */
  maxReconnectAttempts?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<WsEventType | "*", Set<Handler>>();
  private reconnectAttempts = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly url: string;
  private readonly token?: string;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(private readonly options: WebSocketClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  }

  connect(): void {
    this.closed = false;
    this.reconnectAttempts = 0;
    this.open();
  }

  private open(): void {
    const url = this.token
      ? `${this.url}?token=${encodeURIComponent(this.token)}`
      : this.url;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as WsEvent;
        this.dispatch(parsed);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (!this.closed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this, which handles reconnect
    };
  }

  private dispatch(event: WsEvent): void {
    const specific = this.handlers.get(event.type);
    const wildcard = this.handlers.get("*");
    if (specific) for (const fn of specific) fn(event);
    if (wildcard) for (const fn of wildcard) fn(event);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  on<T = unknown>(type: WsEventType | "*", handler: Handler<T>): () => void {
    if (!this.handlers.has(type as WsEventType)) {
      this.handlers.set(type as WsEventType, new Set());
    }
    const set = this.handlers.get(type as WsEventType)!;
    const wrapped = handler as Handler;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.handlers.clear();
  }
}
