const BASE_URL = localStorage.getItem('anorion_base_url') || 'http://localhost:4250'

function getApiKey(): string | null {
  return localStorage.getItem('anorion_api_key')
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = getApiKey()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText)
    throw new Error(`API ${res.status}: ${body}`)
  }

  // Handle plain text responses (e.g., metrics)
  const ct = res.headers.get('content-type')
  if (ct && !ct.includes('json')) {
    return res.text() as unknown as T
  }

  return res.json()
}

// --- Agents ---
export const agents = {
  list: () => request<{ agents: import('./types').AgentSummary[]; total: number }>('/api/v1/agents'),
  get: (id: string) => request<import('./types').Agent>(`/api/v1/agents/${id}`),
  create: (config: unknown) => request<import('./types').Agent>('/api/v1/agents', { method: 'POST', body: JSON.stringify(config) }),
  updateConfig: (id: string, config: unknown) => request<import('./types').Agent>(`/api/v1/agents/${id}/config`, { method: 'PUT', body: JSON.stringify(config) }),
  delete: (id: string) => request<void>(`/api/v1/agents/${id}`, { method: 'DELETE' }),
  restart: (id: string) => request<void>(`/api/v1/agents/${id}/restart`, { method: 'POST' }),
  pause: (id: string) => request<void>(`/api/v1/agents/${id}/pause`, { method: 'POST' }),
  resume: (id: string) => request<void>(`/api/v1/agents/${id}/resume`, { method: 'POST' }),
}

// --- Sessions ---
export const sessions = {
  list: (params?: string) => request<{ sessions: import('./types').SessionSummary[]; total: number }>(`/api/v1/sessions${params ? `?${params}` : ''}`),
  get: (id: string) => request<import('./types').Session>(`/api/v1/sessions/${id}?includeMessages=true&includeToolCalls=true`),
  sendMessage: (id: string, content: string) => request<{ messageId: string }>(`/api/v1/sessions/${id}/message`, { method: 'POST', body: JSON.stringify({ role: 'user', content }) }),
  steer: (id: string, instruction: string) => request<{ ok: boolean }>(`/api/v1/sessions/${id}/steer`, { method: 'POST', body: JSON.stringify({ instruction }) }),
  compact: (id: string) => request<unknown>(`/api/v1/sessions/${id}/compact`, { method: 'POST' }),
  destroy: (id: string) => request<void>(`/api/v1/sessions/${id}`, { method: 'DELETE' }),
}

// --- Tools ---
export const tools = {
  list: () => request<{ tools: import('./types').ToolSummary[] }>('/api/v1/tools'),
  get: (name: string) => request<import('./types').Tool>(`/api/v1/tools/${name}`),
}

// --- Cron ---
export const cron = {
  list: () => request<{ jobs: import('./types').CronJob[] }>('/api/v1/cron'),
  create: (job: unknown) => request<import('./types').CronJob>('/api/v1/cron', { method: 'POST', body: JSON.stringify(job) }),
  update: (id: string, job: unknown) => request<import('./types').CronJob>(`/api/v1/cron/${id}`, { method: 'PUT', body: JSON.stringify(job) }),
  delete: (id: string) => request<void>(`/api/v1/cron/${id}`, { method: 'DELETE' }),
  run: (id: string) => request<{ runId: string; status: string }>(`/api/v1/cron/${id}/run`, { method: 'POST' }),
}

// --- Gateway ---
export const gateway = {
  status: () => request<import('./types').GatewayStatus>('/api/v1/gateway/status'),
  config: () => request<unknown>('/api/v1/gateway/config'),
  updateConfig: (config: unknown) => request<{ ok: boolean; requiresRestart: boolean }>('/api/v1/gateway/config', { method: 'PUT', body: JSON.stringify(config) }),
  restart: () => request<void>('/api/v1/gateway/restart', { method: 'POST' }),
}

// --- API Keys ---
export const keys = {
  list: () => request<{ keys: import('./types').ApiKey[] }>('/api/v1/keys'),
  create: (name: string, scopes: string[]) => request<import('./types').ApiKey>('/api/v1/keys', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  delete: (id: string) => request<void>(`/api/v1/keys/${id}`, { method: 'DELETE' }),
}

// --- WebSocket ---
export function createWebSocket(): WebSocket | null {
  const apiKey = getApiKey()
  if (!apiKey) return null

  const wsUrl = BASE_URL.replace(/^http/, 'ws') + `/api/v1/ws?token=${apiKey}`
  return new WebSocket(wsUrl)
}

export { BASE_URL, getApiKey }
