import type {} from "./types.js";
import {
  AnorionError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";
import { AgentsResource } from "./resources/agents.js";
import { SessionsResource } from "./resources/sessions.js";
import { ChatResource } from "./resources/chat.js";
import { ToolsResource } from "./resources/tools.js";
import { ChannelsResource } from "./resources/channels.js";
import { ConfigResource } from "./resources/config.js";
import { TracesResource } from "./resources/traces.js";
import { SearchResource } from "./resources/search.js";
import { HealthResource } from "./resources/health.js";

export interface AnorionClientOptions {
  baseUrl: string;
  apiKey?: string;
  jwt?: string;
  /** Max retries on transient errors (default 2) */
  maxRetries?: number;
  /** Request timeout in ms (default 30_000) */
  timeoutMs?: number;
}

export class AnorionClient {
  public readonly agents: AgentsResource;
  public readonly sessions: SessionsResource;
  public readonly chat: ChatResource;
  public readonly tools: ToolsResource;
  public readonly channels: ChannelsResource;
  public readonly config: ConfigResource;
  public readonly traces: TracesResource;
  public readonly search: SearchResource;
  public readonly health: HealthResource;

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: AnorionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;

    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (options.apiKey) {
      this.headers["X-API-Key"] = options.apiKey;
    }
    if (options.jwt) {
      this.headers["Authorization"] = `Bearer ${options.jwt}`;
    }

    this.agents = new AgentsResource(this);
    this.sessions = new SessionsResource(this);
    this.chat = new ChatResource(this);
    this.tools = new ToolsResource(this);
    this.channels = new ChannelsResource(this);
    this.config = new ConfigResource(this);
    this.traces = new TracesResource(this);
    this.search = new SearchResource(this);
    this.health = new HealthResource(this);
  }

  // ── HTTP helpers ──

  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.request<T>("GET", url);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>("POST", url, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>("PATCH", url, body);
  }

  async del(path: string): Promise<void> {
    const url = this.buildUrl(path);
    await this.request<void>("DELETE", url);
  }

  /** Returns the raw Response (used for streaming endpoints). */
  async postRaw(path: string, body?: unknown): Promise<Response> {
    const url = this.buildUrl(path);
    return this.requestRaw("POST", url, body);
  }

  /** Throw a typed error based on HTTP status. Used by resource modules for streaming. */
  async handleError(response: Response): Promise<never> {
    throw await this.toError(response);
  }

  // ── internals ──

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.requestRaw(method, url, body);

        if (res.status === 204 || res.headers.get("content-length") === "0") {
          return undefined as T;
        }

        if (res.ok) {
          return (await res.json()) as T;
        }

        throw await this.toError(res);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry on transient errors (rate limit, network, 5xx)
        if (err instanceof RateLimitError) {
          const wait = err.retryAfter * 1000;
          await this.sleep(wait);
          continue;
        }
        if (err instanceof AnorionError && err.status >= 500) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await this.sleep(backoff);
          continue;
        }

        // Non-retryable — throw immediately
        throw err;
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async requestRaw(method: string, url: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return fetch(url, init);
  }

  private async toError(res: Response): Promise<AnorionError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }

    switch (res.status) {
      case 401:
        return new AuthenticationError(
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : undefined,
          body,
        );
      case 404: {
        const msg = typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : "Not found";
        return new NotFoundError("Resource", msg, body);
      }
      case 422: {
        const violations = typeof body === "object" && body !== null && "violations" in body
          ? (body as { violations: Array<{ field: string; message: string }> }).violations
          : [];
        return new ValidationError(violations, body);
      }
      case 429: {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        return new RateLimitError(retryAfter, body);
      }
      default:
        return new AnorionError(
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${res.status}`,
          res.status,
          body,
        );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
