import type {
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  Session,
  ToolDefinition,
  Channel,
  MemoryEntry,
  ApiKey,
  SystemStats,
  AuditEntry,
  StreamEvent,
  ChatResponse,
  WSMessage,
} from "./types";

const DEFAULT_GATEWAY_URL = "http://localhost:4250";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  baseUrl?: string,
): Promise<T> {
  const url = `${baseUrl || DEFAULT_GATEWAY_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error");
    throw new ApiError(res.status, body);
  }
  const data = await res.json();
  return data as T;
}

// ─── Agents ───────────────────────────────────────────────────────────

export async function listAgents(baseUrl?: string): Promise<Agent[]> {
  return request<Agent[]>("/api/v1/agents", {}, baseUrl);
}

export async function getAgent(
  id: string,
  baseUrl?: string,
): Promise<Agent> {
  return request<Agent>(`/api/v1/agents/${id}`, {}, baseUrl);
}

export async function createAgent(
  data: CreateAgentInput,
  baseUrl?: string,
): Promise<Agent> {
  return request<Agent>("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify(data),
  }, baseUrl);
}

export async function updateAgent(
  id: string,
  data: UpdateAgentInput,
  baseUrl?: string,
): Promise<Agent> {
  return request<Agent>(`/api/v1/agents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  }, baseUrl);
}

export async function deleteAgent(
  id: string,
  baseUrl?: string,
): Promise<void> {
  await request<void>(`/api/v1/agents/${id}`, { method: "DELETE" }, baseUrl);
}

// ─── Chat ─────────────────────────────────────────────────────────────

export async function sendMessage(
  agentId: string,
  content: string,
  sessionId?: string,
  baseUrl?: string,
): Promise<ChatResponse> {
  return request<ChatResponse>(`/api/v1/agents/${agentId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, sessionId }),
  }, baseUrl);
}

export async function* streamMessage(
  agentId: string,
  content: string,
  sessionId?: string,
  baseUrl?: string,
): AsyncGenerator<StreamEvent> {
  const url = `${baseUrl || DEFAULT_GATEWAY_URL}/api/v1/agents/${agentId}/stream`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, sessionId }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error");
    throw new ApiError(res.status, body);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const event: StreamEvent = JSON.parse(payload);
          yield event;
        } catch {
          // skip malformed
        }
      }
    }
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────

export async function listSessions(
  agentId: string,
  baseUrl?: string,
): Promise<Session[]> {
  return request<Session[]>(
    `/api/v1/agents/${agentId}/sessions`,
    {},
    baseUrl,
  );
}

export async function deleteSession(
  agentId: string,
  sessionId: string,
  baseUrl?: string,
): Promise<void> {
  await request<void>(
    `/api/v1/agents/${agentId}/sessions/${sessionId}`,
    { method: "DELETE" },
    baseUrl,
  );
}

// ─── Memory ───────────────────────────────────────────────────────────

export async function listMemory(
  agentId: string,
  baseUrl?: string,
): Promise<MemoryEntry[]> {
  return request<MemoryEntry[]>(
    `/api/v1/agents/${agentId}/memory`,
    {},
    baseUrl,
  );
}

export async function searchMemory(
  agentId: string,
  query: string,
  baseUrl?: string,
): Promise<MemoryEntry[]> {
  return request<MemoryEntry[]>(
    `/api/v1/agents/${agentId}/memory/search`,
    { method: "POST", body: JSON.stringify({ query }) },
    baseUrl,
  );
}

// ─── Tools ────────────────────────────────────────────────────────────

export async function listTools(baseUrl?: string): Promise<ToolDefinition[]> {
  return request<ToolDefinition[]>("/api/v1/tools", {}, baseUrl);
}

export async function executeTool(
  toolName: string,
  params: Record<string, unknown>,
  baseUrl?: string,
): Promise<unknown> {
  return request<unknown>(`/api/v1/tools/${toolName}/execute`, {
    method: "POST",
    body: JSON.stringify(params),
  }, baseUrl);
}

// ─── Channels ─────────────────────────────────────────────────────────

export async function listChannels(baseUrl?: string): Promise<Channel[]> {
  return request<Channel[]>("/api/v1/channels", {}, baseUrl);
}

export async function startChannel(
  name: string,
  baseUrl?: string,
): Promise<void> {
  await request<void>(
    `/api/v1/channels/${name}/start`,
    { method: "POST" },
    baseUrl,
  );
}

export async function stopChannel(
  name: string,
  baseUrl?: string,
): Promise<void> {
  await request<void>(
    `/api/v1/channels/${name}/stop`,
    { method: "POST" },
    baseUrl,
  );
}

// ─── Stats / Audit ────────────────────────────────────────────────────

export async function getStats(baseUrl?: string): Promise<SystemStats> {
  return request<SystemStats>("/api/v1/stats", {}, baseUrl);
}

export async function getAuditLog(
  params?: { limit?: number; offset?: number },
  baseUrl?: string,
): Promise<AuditEntry[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return request<AuditEntry[]>(
    `/api/v1/audit${query ? `?${query}` : ""}`,
    {},
    baseUrl,
  );
}

// ─── API Keys ─────────────────────────────────────────────────────────

export async function listApiKeys(baseUrl?: string): Promise<ApiKey[]> {
  return request<ApiKey[]>("/api/v1/keys", {}, baseUrl);
}

export async function createApiKey(
  name: string,
  scopes: string[],
  baseUrl?: string,
): Promise<ApiKey & { key: string }> {
  return request<ApiKey & { key: string }>("/api/v1/keys", {
    method: "POST",
    body: JSON.stringify({ name, scopes }),
  }, baseUrl);
}

export async function deleteApiKey(
  id: string,
  baseUrl?: string,
): Promise<void> {
  await request<void>(`/api/v1/keys/${id}`, { method: "DELETE" }, baseUrl);
}

// ─── WebSocket ────────────────────────────────────────────────────────

export function createWSConnection(
  onMessage: (msg: WSMessage) => void,
  baseUrl?: string,
): { close: () => void } {
  const wsUrl = (baseUrl || DEFAULT_GATEWAY_URL).replace(/^http/, "ws");
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data as string);
        onMessage(msg);
      } catch {
        // skip malformed
      }
    };

    ws.onclose = () => {
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

// ─── Mock data helpers ────────────────────────────────────────────────

export function getMockStats(): SystemStats {
  return {
    agents: { total: 5, active: 3 },
    sessions: { total: 42, active: 7 },
    tokens: { used: 125_000, budget: 500_000 },
    tools: 12,
    uptime: 86400,
  };
}

export function getMockTokenUsage() {
  const days = 7;
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    data.push({
      date: d.toLocaleDateString("en-US", { weekday: "short" }),
      tokensIn: Math.floor(Math.random() * 5000) + 2000,
      tokensOut: Math.floor(Math.random() * 8000) + 3000,
    });
  }
  return data;
}
