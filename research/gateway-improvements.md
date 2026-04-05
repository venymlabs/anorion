# Anorion Gateway Improvements: Path to Top-Tier Agent Gateway

> Analysis date: 2026-04-05
> Based on: Anorion codebase audit + research into Portkey AI, LiteLLM, Temporal, Trigger.dev, Vercel AI SDK, Haystack, n8n, Huginn

---

## Executive Summary

Anorion already has a strong foundation: plugin-based channels, sub-agent spawning, multi-gateway federation, skill hot-reload, SSE streaming, and SQLite persistence. Compared to the platforms studied, the biggest gaps are in **observability**, **multi-tenancy**, **provider normalization**, and **durable execution**. This document provides prioritized recommendations to close those gaps.

---

## Current State Assessment

### What Anorion Does Well

| Area | Strength |
|------|----------|
| Architecture | Clean separation: gateway/channels/agents/bridge/memory/scheduler/tools |
| API | Comprehensive REST CRUD for agents, sessions, memory, tools, schedules, bridge |
| Streaming | SSE for chat streaming, WebSocket for real-time events |
| Federation | Bridge protocol with client/server/federator for multi-gateway mesh |
| Channels | Plugin adapter pattern (Telegram, Webhook implemented) |
| Skills | YAML manifests with dependency resolution and hot-reload |
| Memory | SQLite + FTS5 search, LRU cache, context compaction |
| Sub-agents | Depth/concurrency/TTL limits, isolated memory, auto-cleanup |
| Config | Zod-validated YAML with env var substitution |
| Rate limiting | Sliding window per IP (60 msg/min, 120 read/min) |

### Critical Gaps vs. Leading Platforms

| Gap | Portkey/LiteLLM | Temporal/Trigger.dev | Anorion |
|-----|----------------|----------------------|---------|
| Provider normalization | 100-1600+ models normalized to OpenAI format | N/A (orchestration layer) | Single provider per agent, no normalization |
| Observability | Per-request traces, token/cost tracking, dashboards | Event sourcing, OTel, Prometheus | Basic Prometheus metrics, no per-request tracing |
| Auth model | API keys with scoping, virtual keys, RBAC, SSO | mTLS, namespace isolation | API key with scopes (basic) |
| Durability | N/A (stateless gateway) | Event sourcing + replay / CRIU checkpointing | No crash recovery for in-flight requests |
| Multi-tenancy | Workspaces, per-key budgets, usage quotas | Namespaces, per-workflow limits | None |
| Caching | Exact + semantic cache | N/A | None |
| SDK | Python + JS SDKs, OpenAI-compatible | TypeScript SDK | REST API only |

---

## Recommendations

### 1. Gateway API Completeness

#### 1.1 Provider Normalization Layer (P0, XL)

**Why**: Portkey and LiteLLM's core value is normalizing 100+ providers into one OpenAI-compatible API. Anorion currently binds one provider per agent config with no abstraction.

**Recommendation**: Create a provider adapter registry that normalizes all LLM calls to a unified `ChatCompletion` request/response shape.

```typescript
// src/providers/types.ts
interface ProviderAdapter {
  id: string;                          // e.g. "openai", "anthropic", "google"
  chatCompletion(req: NormalizedRequest): AsyncIterable<StreamChunk>;
  countTokens(text: string): number;
  validateConfig(config: Record<string, unknown>): boolean;
}

interface NormalizedRequest {
  model: string;                       // e.g. "gpt-4o", "claude-sonnet-4-20250514"
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  metadata?: Record<string, string>;   // trace ID, user ID, etc.
}

interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
}
```

```typescript
// src/providers/registry.ts
class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void { ... }
  resolve(model: string): { adapter: ProviderAdapter; resolvedModel: string } { ... }

  // Support "provider/model" format like LiteLLM
  // e.g. "openai/gpt-4o" -> OpenAI adapter, model "gpt-4o"
  //      "anthropic/claude-sonnet-4-20250514" -> Anthropic adapter
}
```

**Dependencies**: None — this is foundational.

---

#### 1.2 OpenAI-Compatible Endpoint (P0, L)

**Why**: LiteLLM and Portkey both expose `/v1/chat/completions`. Any OpenAI SDK works as a drop-in client. This is table stakes for a gateway.

**Recommendation**: Add a compatibility layer.

```typescript
// src/gateway/openai-compat.ts
app.post("/v1/chat/completions", async (c) => {
  const req = c.req.json();  // OpenAI format
  const { adapter, resolvedModel } = registry.resolve(req.model);
  const normalized = translateOpenAIRequest(req);

  if (req.stream) {
    return streamSSE(c, async (stream) => {
      for await (const chunk of adapter.chatCompletion(normalized)) {
        stream.write(formatOpenAIChunk(chunk));
      }
      stream.write("data: [DONE]\n\n");
    });
  }
  // non-streaming
  const result = await collectStream(adapter.chatCompletion(normalized));
  return c.json(formatOpenAIResponse(result));
});

// Also: /v1/models, /v1/embeddings, /v1/images/generations
```

**Dependencies**: Provider normalization layer (1.1).

---

#### 1.3 Authentication Overhaul (P0, M)

**Why**: Current API key auth is IP-based rate limiting with scope validation. Portkey/LiteLLM offer virtual keys, RBAC, per-key budgets, and team scoping.

**Recommendations**:

| Feature | Priority | Complexity | Notes |
|---------|----------|------------|-------|
| API key CRUD via `/v1/keys` | P0 | S | Already stubbed in routes-v2.ts |
| Per-key rate limits (RPM/TPM) | P0 | M | Replace IP-based with key-based |
| Per-key model restrictions | P1 | S | Key can only use whitelisted models |
| Per-key budget limits | P1 | M | Monthly spend cap per key |
| JWT bearer tokens | P1 | M | For user-facing auth flows |
| Scoped keys (read/write/admin) | P0 | S | Already partially in place |

**Dependencies**: None.

---

#### 1.4 Request/Response Caching (P1, M)

**Why**: Portkey offers exact-match and semantic caching. This reduces cost and latency for repeated queries.

**Recommendation**: Two-tier cache.

```typescript
// src/cache/layer.ts
interface CacheLayer {
  // Exact match on hash of (model + messages + temperature)
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, response: CachedResponse, ttl: number): Promise<void>;

  // Optional: semantic similarity via embeddings
  semanticGet(embedding: number[], threshold: number): Promise<CachedResponse | null>;
}

// Implementation: SQLite for exact, optional vector extension for semantic
```

**Dependencies**: Provider normalization (1.1) for normalized request hashing.

---

#### 1.5 Load Balancing & Fallbacks (P1, L)

**Why**: LiteLLM's Router provides weighted, latency-based, cost-based, and least-busy routing across deployments. Portkey has automatic fallbacks and canary testing.

**Recommendation**: Agent configs gain a `providers` array with routing strategy.

```yaml
# anorion.yaml
agents:
  - id: assistant
    providers:
      - provider: openai
        model: gpt-4o
        weight: 60
        priority: 1
      - provider: anthropic
        model: claude-sonnet-4-20250514
        weight: 40
        priority: 1
      - provider: openai
        model: gpt-4o-mini
        priority: 2          # fallback
    routing:
      strategy: weighted     # weighted | latency | cost | least-busy
      fallback_on: [429, 500, 503]
      retry:
        max_attempts: 3
        backoff: exponential
```

**Dependencies**: Provider normalization (1.1).

---

### 2. Observability

#### 2.1 Per-Request Tracing (P0, M)

**Why**: Portkey logs every request/response with full context. Temporal has event-sourced history. Anorion has no per-request tracing.

**Recommendation**: Structured logging with trace IDs propagated through the entire request lifecycle.

```typescript
// src/observability/tracer.ts
interface RequestTrace {
  traceId: string;            // propagated to all sub-operations
  requestId: string;          // unique per HTTP request
  agentId: string;
  sessionId?: string;
  apiKeyId: string;
  model: string;
  provider: string;
  startTime: number;
  endTime?: number;
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost?: number;              // calculated from model pricing
  status: "pending" | "success" | "error";
  error?: { code: string; message: string };
  toolCalls?: Array<{ name: string; duration: number }>;
}

// Middleware: auto-inject traceId into every request
// Propagate via context to agent execution, tool calls, memory ops
// Write to SQLite `traces` table + emit to WebSocket subscribers
```

**Dependencies**: None.

---

#### 2.2 Token Usage & Cost Tracking (P0, M)

**Why**: LiteLLM maintains an open-source pricing database and auto-calculates cost per request. Essential for billing and optimization.

**Recommendation**: Per-agent, per-key, per-session usage accumulation.

```sql
CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  trace_id TEXT REFERENCES traces(id),
  api_key_id TEXT,
  agent_id TEXT,
  session_id TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,               -- from pricing table
  created_at INTEGER
);

-- Rollup materialized view for dashboard queries
CREATE VIEW usage_daily AS
  SELECT date(created_at) as day, api_key_id, agent_id, model,
    SUM(prompt_tokens), SUM(completion_tokens), SUM(cost_usd), COUNT(*)
  FROM token_usage GROUP BY day, api_key_id, agent_id, model;
```

**Dependencies**: Tracing (2.1), provider normalization (1.1) for model identification.

---

#### 2.3 Latency Metrics (P0, S)

**Why**: p50/p95/p99 latencies are standard in every gateway platform.

**Recommendation**: Extend existing Prometheus metrics with histograms.

```typescript
// Already have /metrics in routes-v2.ts
// Add histograms:
const requestDuration = new Histogram({
  name: "anorion_request_duration_seconds",
  help: "Request duration in seconds",
  labelNames: ["method", "path", "status", "agent_id", "model"],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

const tokenLatency = new Histogram({
  name: "anorion_time_to_first_token_seconds",
  help: "Time from request start to first streamed token",
  labelNames: ["model", "provider"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
});
```

**Dependencies**: None.

---

#### 2.4 OpenTelemetry Integration (P1, M)

**Why**: Both Temporal and Trigger.dev have first-class OTel support. This enables integration with Grafana, Jaeger, Datadog, etc.

**Recommendation**: OTel SDK initialization with configurable exporters.

```typescript
// src/observability/otel.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
  instrumentations: ["@opentelemetry/instrumentation-http"],
});
sdk.start();

// Auto-instrument HTTP server + manual spans for agent execution
```

**Dependencies**: Tracing (2.1).

---

#### 2.5 Health Check & Readiness (P0, S)

**Why**: Standard for production deployments. Already partially in place via Prometheus `/metrics`.

**Recommendation**: Dedicated health endpoints.

```typescript
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

app.get("/ready", async (c) => {
  const checks = {
    db: await db.select({ 1: sql`1` }).from(sql`sqlite_master`).limit(1),
    agents: agentRegistry.list().length > 0,
  };
  const healthy = Object.values(checks).every(Boolean);
  return c.json({ ready: healthy, checks }, healthy ? 200 : 503);
});
```

**Dependencies**: None.

---

### 3. Persistence & Recovery

#### 3.1 Schema Migration System (P0, M)

**Why**: Current SQLite setup uses Drizzle but needs versioned migrations for production.

**Recommendation**: Use Drizzle Kit for schema versioning.

```bash
# drizzle.config.ts already likely exists
# Add migration workflow:
# 1. drizzle-kit generate  (after schema changes)
# 2. drizzle-kit migrate   (on startup)
```

Ensure all tables (agents, sessions, messages, memory, traces, usage, schedules, keys) have proper Drizzle schema definitions and migration files.

**Dependencies**: None.

---

#### 3.2 Message History with Search (P0, M)

**Why**: Every platform persists message history. Anorion stores memory entries but not full message transcripts with search.

**Recommendation**: Dedicated messages table with FTS.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,
  model TEXT,
  token_count INTEGER,
  tool_calls TEXT,              -- JSON array of tool calls
  tool_call_id TEXT,
  metadata TEXT,                -- JSON blob for extensibility
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

-- FTS5 for content search
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content=messages, content_rowid=rowid
);
```

API endpoint already exists: `/api/v1/agents/:id/sessions` and memory search. Extend to full message search:

```typescript
app.get("/api/v1/sessions/:id/messages", async (c) => {
  const { q, role, before, after, limit } = c.req.query();
  // Search + filter + paginate
});

app.get("/api/v1/sessions/:id/messages/search", async (c) => {
  const { q, limit } = c.req.query();
  // FTS5 search across session messages
});
```

**Dependencies**: Schema migration (3.1).

---

#### 3.3 Agent State Snapshots for Crash Recovery (P1, L)

**Why**: Temporal recovers via event sourcing replay. Trigger.dev uses CRIU checkpointing. Anorion currently loses all in-flight agent state on crash.

**Recommendation**: Periodic state snapshots + WAL for recovery.

```typescript
// src/recovery/snapshot.ts
interface AgentSnapshot {
  agentId: string;
  sessionId: string;
  status: "thinking" | "tool_call" | "streaming" | "idle";
  pendingToolCalls: Array<{ id: string; name: string; startedAt: number }>;
  messageHistory: Message[];
  contextWindow: Message[];    // current compacted context
  lastActivityAt: number;
}

class SnapshotManager {
  // Snapshot every N seconds for active agents
  periodicSnapshot(agent: Agent): void;

  // On crash recovery: scan snapshots, resume pending operations
  recover(): Promise<void>;

  // WAL for in-flight tool calls
  appendToolCall(agentId: string, toolCall: ToolCall): void;
  completeToolCall(agentId: string, toolCallId: string, result: unknown): void;
}
```

Recovery flow:
1. On startup, load all snapshots with status != "idle"
2. For "thinking" status: re-send last context to LLM (idempotent)
3. For "tool_call" status: check WAL, resume pending tools or return results
4. For "streaming" status: re-initiate stream (client must reconnect via SSE)

**Dependencies**: Message history (3.2).

---

#### 3.4 Configuration Versioning (P2, S)

**Why**: Haystack serializes pipelines to YAML for version control. Production systems need config rollback.

**Recommendation**: Store config versions in SQLite with diff capability.

```sql
CREATE TABLE config_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  config_yaml TEXT NOT NULL,
  changed_by TEXT,              -- API key or user
  change_summary TEXT,
  created_at INTEGER NOT NULL
);

-- API to list versions, diff, and rollback
```

**Dependencies**: Schema migration (3.1).

---

### 4. Multi-Tenancy

#### 4.1 Workspace Isolation (P1, XL)

**Why**: Portkey has Organizations > Workspaces > Users. LiteLLM has teams with per-key scoping. Anorion has no multi-tenancy.

**Recommendation**: Workspace-scoped resources.

```typescript
// src/shared/types.ts additions
interface Workspace {
  id: string;
  name: string;
  slug: string;
  settings: {
    defaultModel: string;
    maxTokensPerDay: number;
    allowedModels: string[];
    allowedProviders: string[];
  };
  createdAt: number;
}

// All resources gain a workspaceId field:
// agents.workspace_id, sessions.workspace_id, messages.workspace_id,
// token_usage.workspace_id, schedules.workspace_id

// API key is bound to a workspace
// All queries filtered by workspace
// Cross-workspace access is forbidden
```

Database changes:
```sql
ALTER TABLE agents ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
-- etc.

-- Row-level filtering in all queries
SELECT * FROM agents WHERE workspace_id = ?;
```

**Dependencies**: Auth overhaul (1.3).

---

#### 4.2 Usage Quotas & Billing Hooks (P1, M)

**Why**: Portkey has per-key budget limits. LiteLLM enforces spend limits per team/user.

**Recommendation**: Configurable quotas with webhook notifications.

```typescript
// src/billing/quota.ts
interface Quota {
  workspaceId: string;
  period: "daily" | "monthly";
  maxTokens: number;
  maxCostUsd: number;
  maxRequests: number;
}

interface QuotaEnforcer {
  check(workspaceId: string): Promise<{ allowed: boolean; remaining: Quota }>;
  record(workspaceId: string, usage: TokenUsage): Promise<void>;
  onExceeded: WebhookCallback;    // POST to external billing system
}
```

```yaml
# anorion.yaml
billing:
  quotas:
    default:
      period: monthly
      max_tokens: 10_000_000
      max_cost_usd: 100
    premium:
      period: monthly
      max_tokens: 100_000_000
      max_cost_usd: 1000
  webhooks:
    quota_exceeded: "https://billing.example.com/quota-event"
    usage_report: "https://billing.example.com/usage"
```

**Dependencies**: Token usage tracking (2.2), workspace isolation (4.1).

---

### 5. Developer Experience

#### 5.1 TypeScript SDK (P1, L)

**Why**: Portkey, LiteLLM, Trigger.dev, and Vercel AI SDK all provide SDKs. Anorion currently has only REST API.

**Recommendation**: Minimal TypeScript SDK published to npm.

```typescript
// @anorion/sdk
import { Anorion } from "@anorion/sdk";

const client = new Anorion({
  baseUrl: "http://localhost:3000",
  apiKey: "anorion_sk_...",
  workspace: "my-workspace",    // optional, for multi-tenant
});

// Agents
const agent = await client.agents.create({
  id: "assistant",
  model: "openai/gpt-4o",
  systemPrompt: "You are helpful.",
  tools: ["web-search", "calculator"],
});

// Chat (non-streaming)
const response = await client.agents.chat("assistant", {
  messages: [{ role: "user", content: "Hello" }],
  sessionId: "sess_123",
});

// Chat (streaming) — returns AsyncIterable matching Vercel AI SDK pattern
const stream = await client.agents.stream("assistant", {
  messages: [{ role: "user", content: "Hello" }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}

// Sessions
const sessions = await client.sessions.list("assistant");
const messages = await client.sessions.getMessages("sess_123");

// Tools
const tools = await client.tools.list();

// Memory
await client.memory.store("assistant", {
  content: "User prefers dark mode",
  category: "preferences",
});
const results = await client.memory.search("assistant", "dark mode");

// Schedules
await client.schedules.create({
  agentId: "assistant",
  cron: "0 9 * * *",
  action: { type: "agent_turn", message: "Daily standup summary" },
});
```

**Dependencies**: OpenAI-compatible endpoint (1.2) can be leveraged for standard SDKs.

---

#### 5.2 Python SDK (P2, L)

**Why**: LiteLLM's Python SDK is its primary interface. The AI/ML ecosystem is Python-heavy.

**Recommendation**: Mirror TypeScript SDK API in Python.

```python
# anorion-sdk
from anorion import Anorion

client = Anorion(api_key="anorion_sk_...", base_url="http://localhost:3000")

response = client.agents.chat("assistant", messages=[
    {"role": "user", "content": "Hello"}
])

# Streaming
for chunk in client.agents.stream("assistant", messages=[...]):
    print(chunk.text, end="")
```

**Dependencies**: TypeScript SDK (5.1) for API contract validation.

---

#### 5.3 Webhook System (P1, M)

**Why**: n8n and Huginn are built on webhooks. Every platform provides outbound event notifications.

**Recommendation**: Configurable webhooks for key lifecycle events.

```typescript
// src/webhooks/manager.ts
type WebhookEvent =
  | "agent.created" | "agent.updated" | "agent.deleted"
  | "session.created" | "session.completed"
  | "message.received" | "message.completed"
  | "tool.executed"
  | "schedule.triggered"
  | "quota.warning" | "quota.exceeded"
  | "error.critical";

interface WebhookConfig {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret: string;              // for HMAC signature verification
  workspaceId: string;
  active: boolean;
}

// Delivery with retry (exponential backoff, max 5 attempts)
// HMAC-SHA256 signature in X-Anorion-Signature header
// Event ID for idempotency
```

```yaml
# anorion.yaml
webhooks:
  - url: "https://myapp.com/api/anorion-events"
    events: ["message.completed", "tool.executed", "error.critical"]
    secret: "${WEBHOOK_SECRET}"
```

**Dependencies**: None.

---

#### 5.4 Plugin API (P2, XL)

**Why**: Haystack's component model, n8n's node system, and Huginn's agent model all provide extension APIs.

**Recommendation**: Formal plugin interface for extending gateway behavior.

```typescript
// src/plugins/api.ts
interface AnorionPlugin {
  name: string;
  version: string;

  // Lifecycle hooks
  onLoad?(ctx: PluginContext): Promise<void>;
  onUnload?(): Promise<void>;

  // Middleware hooks
  beforeRequest?(req: GatewayRequest): Promise<GatewayRequest | null>;  // return null to block
  afterResponse?(req: GatewayRequest, res: GatewayResponse): Promise<void>;

  // Channel hooks
  onChannelMessage?(channel: string, message: Message): Promise<Message | null>;

  // Tool hooks
  registerTools?(): ToolDefinition[];

  // Provider hooks
  registerProviders?(): ProviderAdapter[];

  // Memory hooks
  onMemoryStore?(entry: MemoryEntry): Promise<MemoryEntry>;
  onMemoryRetrieve?(results: MemoryEntry[]): Promise<MemoryEntry[]>;
}

interface PluginContext {
  db: Database;
  config: Record<string, unknown>;
  eventBus: EventBus;
  logger: Logger;
  registerChannel(adapter: ChannelAdapter): void;
  registerRoute(path: string, handler: RouteHandler): void;
}
```

**Dependencies**: None — purely additive.

---

#### 5.5 Hot-Reload for Agent Configs (P1, S)

**Why**: Already partially implemented for skills via `SkillManager` with file watching. Extend to agents.

**Recommendation**: File watcher on agent config directory + runtime reload endpoint.

```typescript
// Extend existing skill hot-reload to cover agents
// Add API endpoint:
app.post("/api/v1/agents/:id/reload", async (c) => {
  const agent = agentRegistry.get(c.req.param("id"));
  await agent.reload();    // re-read config, rebind tools, reset context
  return c.json({ reloaded: true });
});

// File watcher for agent YAML files
watch("agents/*.yaml", (event, file) => {
  agentRegistry.reload(path.basename(file, ".yaml"));
});
```

**Dependencies**: None — skill manager already has the pattern.

---

### 6. Scalability

#### 6.1 Redis Pub/Sub for Multi-Instance (P1, L)

**Why**: Current federation uses WebSocket peer-to-peer. For horizontal scaling, need a shared message bus.

**Recommendation**: Optional Redis adapter for event broadcasting across instances.

```typescript
// src/scale/redis-bus.ts
import { Redis } from "ioredis";

class RedisEventBus implements EventBus {
  private pub: Redis;
  private sub: Redis;

  constructor(url: string) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
  }

  async publish(channel: string, event: GatewayEvent): Promise<void> {
    await this.pub.publish(`anorion:${channel}`, JSON.stringify(event));
  }

  subscribe(channel: string, handler: (event: GatewayEvent) => void): void {
    this.sub.subscribe(`anorion:${channel}`);
    this.sub.on("message", (ch, msg) => {
      if (ch === `anorion:${channel}`) handler(JSON.parse(msg));
    });
  }
}

// Channels: agent:{id}:events, session:{id}:messages, gateway:broadcast
```

```yaml
# anorion.yaml
scaling:
  mode: single               # single | redis
  redis:
    url: "${REDIS_URL}"
    prefix: "anorion:"
```

**Dependencies**: None — optional adapter pattern.

---

#### 6.2 Agent Worker Pools (P2, M)

**Why**: Current execution is inline in the HTTP handler. For CPU-intensive tool execution, need worker isolation.

**Recommendation**: Task queue with configurable concurrency.

```typescript
// src/scale/worker-pool.ts
class AgentWorkerPool {
  private queue: PriorityQueue<AgentTask>;
  private workers: Worker[];
  private concurrency: number;

  constructor(concurrency: number = 5) { ... }

  async submit(task: AgentTask): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      this.queue.enqueue({ task, resolve, reject, priority: task.priority });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0 && this.activeWorkers < this.concurrency) {
      const { task, resolve, reject } = this.queue.dequeue();
      this.execute(task).then(resolve).catch(reject);
    }
  }
}
```

**Dependencies**: Redis pub/sub (6.1) for distributed coordination.

---

#### 6.3 Queue-Based Message Processing (P2, L)

**Why**: For reliable message delivery with retries and dead-letter queues.

**Recommendation**: SQLite-based job queue (no external dependency for single-instance) with Redis adapter for multi-instance.

```typescript
// src/scale/queue.ts
interface MessageQueue {
  enqueue(msg: MessageEnvelope, opts?: QueueOptions): Promise<string>;
  dequeue(agentId: string): Promise<MessageEnvelope | null>;
  acknowledge(msgId: string): Promise<void>;
  deadLetter(msgId: string, reason: string): Promise<void>;
}

interface QueueOptions {
  priority: number;
  delay: number;
  maxRetries: number;
  retryDelay: number;
}
```

**Dependencies**: Redis pub/sub (6.1) for distributed mode.

---

## Implementation Roadmap

### Phase 1: Production Readiness (P0 items)

| Item | Complexity | Dependencies | Est. Effort |
|------|-----------|--------------|-------------|
| Per-request tracing with trace IDs | M | None | 1 week |
| Token usage & cost tracking | M | Tracing | 1 week |
| Latency histograms (Prometheus) | S | None | 2 days |
| Health/ready endpoints | S | None | 1 day |
| API key CRUD + per-key rate limits | M | None | 3 days |
| Schema migration system (Drizzle Kit) | M | None | 3 days |
| Message history + FTS search | M | Schema migrations | 1 week |
| Provider normalization layer | XL | None | 2-3 weeks |
| OpenAI-compatible endpoint | L | Provider normalization | 1 week |

**Phase 1 total: ~7-8 weeks**

### Phase 2: Growth Features (P1 items)

| Item | Complexity | Dependencies | Est. Effort |
|------|-----------|--------------|-------------|
| OpenTelemetry integration | M | Tracing | 1 week |
| Request caching (exact + semantic) | M | Provider normalization | 1 week |
| Load balancing & fallbacks | L | Provider normalization | 2 weeks |
| Agent state snapshots & recovery | L | Message history | 2 weeks |
| Workspace isolation | XL | Auth overhaul | 3 weeks |
| Usage quotas & billing hooks | M | Token tracking, workspaces | 1 week |
| Webhook system | M | None | 1 week |
| TypeScript SDK | L | API stable | 2 weeks |
| Hot-reload for agent configs | S | None | 2 days |
| Redis pub/sub adapter | L | None | 2 weeks |

**Phase 2 total: ~15-16 weeks**

### Phase 3: Platform Maturity (P2 items)

| Item | Complexity | Dependencies |
|------|-----------|--------------|
| Python SDK | L | TypeScript SDK |
| Plugin API | XL | Core stable |
| Agent worker pools | M | Redis pub/sub |
| Queue-based message processing | L | Redis pub/sub |
| Configuration versioning | S | Schema migrations |
| JWT bearer tokens | M | Auth overhaul |
| Per-key model restrictions | S | Auth overhaul |
| Per-key budget limits | M | Billing hooks |

---

## Competitive Positioning

After implementing Phase 1 and 2, Anorion would sit in a unique position:

| Capability | Portkey | LiteLLM | Anorion (post-improvements) |
|-----------|---------|---------|-----------------------------|
| Provider normalization | 1600+ models | 100+ providers | 5-10 providers initially |
| OpenAI-compatible API | Yes | Yes | Yes |
| Multi-gateway federation | No | No | **Yes (unique)** |
| Built-in agent execution | No (proxy only) | No (proxy only) | **Yes (unique)** |
| Channel adapters (Telegram, etc.) | No | No | **Yes (unique)** |
| Skill/plugin system | No | No | **Yes (unique)** |
| Scheduling | No | No | **Yes (unique)** |
| Sub-agent spawning | No | No | **Yes (unique)** |
| Observability | Full | Callback-based | Full (traces + OTel) |
| Caching | Exact + semantic | In-memory/Redis | Exact + semantic |
| Multi-tenancy | Full | Team-based | Workspace-based |
| Streaming | SSE | SSE + WebSocket | SSE + WebSocket |

**Anorion's differentiator**: It is not just a proxy/gateway — it is an **agent runtime** with federation, channels, scheduling, sub-agents, and skills. No other platform combines LLM gateway functionality with a full agent execution environment.

---

## Key Architectural Decisions

### Decision 1: Provider Adapter vs. Direct Provider SDKs

**Recommendation**: Provider adapter pattern (like Vercel AI SDK), not raw provider SDKs.

**Rationale**: Adapters normalize responses, enable provider-agnostic tool calling, and make load balancing trivial. Raw SDKs would leak provider-specific types throughout the codebase.

### Decision 2: SSE-First Streaming

**Recommendation**: SSE as primary streaming transport. WebSocket for events only (already in place).

**Rationale**: Vercel AI SDK uses SSE exclusively. It works with CDNs, load balancers, and serverless. WebSocket is valuable for bidirectional events (already used) but unnecessary for response streaming.

### Decision 3: SQLite-First with Optional Redis

**Recommendation**: SQLite for single-instance, Redis adapter for multi-instance.

**Rationale**: Anorion already uses SQLite + Drizzle. Adding Redis as a hard dependency would complicate self-hosted deployments. Make Redis opt-in for horizontal scaling.

### Decision 4: OpenAI-Compatible API as First-Class Citizen

**Recommendation**: The `/v1/chat/completions` endpoint should be the primary API, not a compatibility shim.

**Rationale**: Every LLM tool and SDK speaks OpenAI format. Making this the primary API means Anorion works with LangChain, Cursor, Continue, and any OpenAI-compatible tool from day one.

---

## Appendix: File Impact Map

Which existing files need changes for each recommendation:

| File | Changes |
|------|---------|
| `src/gateway/server.ts` | Add trace middleware, health endpoints, caching logic |
| `src/gateway/routes-v2.ts` | Extend metrics, add workspace filtering, quota enforcement |
| `src/gateway/ws.ts` | Add trace event broadcasting |
| `src/shared/types.ts` | Add Workspace, Quota, Trace, Provider types |
| `src/shared/config.ts` | Add provider, cache, billing, scaling config schemas |
| `src/agents/subagent.ts` | Add trace propagation to child agents |
| `src/bridge/*` | Add trace propagation across federation |
| `src/memory/store.ts` | Minor — already well-structured |
| `src/scheduler/cron.ts` | Add trace context to scheduled tasks |
| `src/tools/skill-manager.ts` | Already has hot-reload — extend pattern |
| New: `src/providers/` | Provider adapter registry + adapters |
| New: `src/observability/` | Tracer, metrics, OTel integration |
| New: `src/cache/` | Exact + semantic cache layer |
| New: `src/recovery/` | Snapshot manager, WAL |
| New: `src/webhooks/` | Webhook manager with retry |
| New: `src/billing/` | Quota enforcer, cost calculator |
| New: `src/scale/` | Redis bus, worker pool, message queue |
| New: `sdk/typescript/` | TypeScript SDK package |
