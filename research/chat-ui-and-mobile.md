# Chat UI & Mobile Frontend Research for Anorion

**Date:** 2026-04-05
**Purpose:** Evaluate existing open-source UIs and recommend a frontend architecture for Anorion.

---

## 1. Existing Open-Source Chat UIs

### 1.1 Open WebUI (open-webui/open-webui)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | SvelteKit (frontend) + Python/FastAPI (backend) |
| **Architecture** | Monorepo, Docker-first deployment, built-in inference engine |
| **Features** | Chat, file upload, RAG, document ingestion, image gen, TTS/STT, function calling, modelfile builder, multi-user auth, admin panel, Ollama + OpenAI-compatible APIs |
| **Streaming** | ✅ SSE streaming |
| **Markdown/Code** | ✅ Full markdown + syntax highlighting |
| **Mobile** | Responsive web, PWA-capable |
| **Extensibility** | Plugin system (Python functions), community plugins |
| **Self-hosting** | `docker run` single command — easiest of all options |
| **License** | MIT |
| **Stars** | 90k+ |

**Verdict:** Best self-hosted AI UI. Deeply Ollama-coupled but supports any OpenAI-compatible API. Its Python backend is a mismatch for Anorion's TypeScript/Node ecosystem, but the UI patterns (chat, RAG, file upload, admin panel) are gold-standard.

---

### 1.2 Lobe Chat (lobehub/lobe-chat)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Next.js 14 (App Router) + React + Zustand + Tailwind + Ant Design |
| **Architecture** | Monorepo with separate packages (UI, database, vector DB). Server-side DB support. |
| **Features** | Multi-model provider support, MCP plugin one-click install, agent marketplace (GPTs-style), TTS/STT, image gen, artifacts, file upload/knowledge base, branching conversations, CoT display |
| **Streaming** | ✅ SSE |
| **Mobile** | PWA + responsive design + desktop app (Tauri) |
| **Extensibility** | Plugin system (function calling), MCP support, agent marketplace |
| **Self-hosting** | Vercel one-click, Docker, Zeabur |
| **License** | MIT |

**Verdict:** The most feature-complete React-based chat UI. Excellent design system (lobehub/ui). MCP support aligns with Anorion's tool architecture. Desktop app via Tauri is a bonus. **Strongest candidate for forking/adapting.**

---

### 1.3 LibreChat (danny-avila/LibreChat)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | React + Express + MongoDB (MERN stack) |
| **Architecture** | Separate frontend (React/Vite) + backend (Express/Node). Docker compose. |
| **Features** | Multi-provider (Anthropic, OpenAI, Google, Azure, Ollama, etc.), agents system, MCP support, code interpreter (sandboxed), file handling, web search, conversation presets, multi-user auth, message search |
| **Streaming** | ✅ SSE |
| **Mobile** | Responsive web |
| **Extensibility** | Custom endpoints, plugins, MCP tools |
| **Self-hosting** | Docker compose, extensive config via librechat.yaml |
| **License** | MIT (source-available, ICU license for some parts) |

**Verdict:** Most comprehensive ChatGPT clone. Node.js backend aligns well with Anorion. Its agent system and multi-provider routing overlap with what Anorion's gateway already does. Could be integrated or serve as inspiration.

---

### 1.4 Chatbot UI (mckaywrigley/chatbot-ui)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Next.js + Supabase (PostgreSQL + Auth) |
| **Architecture** | Full Next.js app with Supabase for persistence |
| **Features** | Multi-model chat, conversation management, presets |
| **Streaming** | ✅ |
| **Mobile** | Basic responsive |
| **Extensibility** | Limited — designed as a simple chat interface |
| **Self-hosting** | Next.js + Supabase |
| **License** | MIT |

**Verdict:** Simpler than others. Good as a lightweight reference but lacks the depth needed for Anorion's agent management features. Updates have been sporadic.

---

### 1.5 Chainlit (Chainlit/chainlit)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Python backend + React frontend (bundled) |
| **Architecture** | Python decorator-based API auto-generates a React chat UI. WebSocket-based. |
| **Features** | Auto-generated chat UI from Python code, file upload, authentication, dataframes, charts, step-by-step display |
| **Streaming** | ✅ WebSocket-based |
| **Mobile** | Responsive |
| **Extensibility** | Python-first, limited UI customization |
| **Self-hosting** | `pip install chainlit` |
| **License** | Apache 2.0 |

**Verdict:** Interesting for rapid prototyping of Python agent UIs. The auto-generation pattern is clever but doesn't fit Anorion's TypeScript architecture. Community-maintained since May 2025. **Skip for production use.**

---

### 1.6 Flowise (FlowiseAI/Flowise)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Node.js + React (visual flow builder) |
| **Architecture** | Electron-like, visual node editor for LangChain flows |
| **Features** | Drag-and-drop agent/chain builder, chat widget embed, API endpoints, vector stores |
| **Mobile** | No |
| **Extensibility** | Custom nodes, LangChain-based |
| **Self-hosting** | `npx flowise start` or Docker |
| **License** | Apache 2.0 (source-available) |

**Verdict:** Visual builder is excellent for non-technical users but heavy. Could inspire a pipeline/agent visual builder for Anorion's dashboard, but not suitable as the primary chat UI.

---

### 1.7 Gradio

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Python + Svelte (bundled frontend) |
| **Architecture** | Python decorator API generates web UI |
| **Features** | Rapid UI prototyping, audio/video/image components, shareable links, HuggingFace Spaces |
| **License** | Apache 2.0 |

**Verdict:** ML demo tool, not a chat platform. Irrelevant for Anorion.

---

### 1.8 OpenCode / Crush (opencode-ai/opencode → charmbracelet/crush)

| Aspect | Details |
|--------|---------|
| **Tech Stack** | Go + Bubble Tea (TUI framework) |
| **Architecture** | Terminal-based AI coding agent |
| **Features** | Multi-provider, file editing, terminal integration |
| **License** | MIT |

**Verdict:** TUI patterns are interesting for a CLI companion to Anorion but not relevant for web/mobile UI. Noted that it moved to Charmbracelet/Crush.

---

## 2. Mobile App Landscape

### 2.1 Onyx (onyx-app/onyx)

GitHub repo appears to be a placeholder/empty project. Not a viable option. **Skip.**

### 2.2 Mobile AI Chat Patterns (from ChatGPT, Claude, etc.)

Key patterns for good mobile AI experience:
- **Streaming responses** with typing indicators
- **Conversation list** with search
- **Push notifications** for async responses
- **Voice input** (STT) with real-time transcription
- **Share extension** — send text/files to AI from any app
- **Widget** — quick prompt from home screen
- **Offline queue** — messages send when back online
- **Haptic feedback** on response completion
- **Long-press actions** — copy, regenerate, share, delete

### 2.3 React Native / Expo for AI Chat

- **Expo** is the standard for React Native apps in 2025-2026
- Key libraries: `expo-router`, `react-native-markdown-display`, `expo-notifications`
- WebSocket support via `react-native` built-in or `expo-network`
- Voice: `expo-speech`, `expo-av` for recording
- Can share business logic with Next.js web app if using a shared API client

### 2.4 Capacitor / Ionic

- Wraps a web app as a native mobile app
- Faster to ship if you already have a responsive web UI
- Tradeoff: less native feel, limited access to native APIs
- Good for MVP, upgrade to React Native later

---

## 3. Current Anorion Gateway API

### 3.1 Existing Endpoints (from server.ts + routes-v2.ts)

**Core:**
- `GET /health` — health check
- `GET /api/v1/agents` — list agents
- `POST /api/v1/agents` — create agent
- `GET /api/v1/agents/:id` — get agent
- `PATCH /api/v1/agents/:id` — update agent
- `DELETE /api/v1/agents/:id` — delete agent
- `POST /api/v1/agents/:id/messages` — send message (sync)
- `POST /api/v1/agents/:id/stream` — send message (SSE streaming)
- `GET /api/v1/agents/:id/sessions` — list sessions
- `GET /api/v1/agents/:id/memory` — list memories
- `POST /api/v1/agents/:id/memory` — save memory
- `POST /api/v1/agents/:id/memory/search` — search memories
- `DELETE /api/v1/agents/:id/memory/:key` — delete memory
- `GET /api/v1/agents/:id/children` — list sub-agents
- `POST /api/v1/agents/:id/spawn` — spawn sub-agent
- `DELETE /api/v1/agents/:id/children/:childId` — kill sub-agent
- `GET /api/v1/tools` — list tools
- `GET /api/v1/channels` — list channels
- `POST /api/v1/channels/:name/start` — start channel
- `POST /api/v1/channels/:name/stop` — stop channel
- `GET /api/v1/schedules` / CRUD — schedule management
- `POST /api/v1/schedules/:id/trigger` — manual trigger

**Extended (routes-v2.ts):**
- `GET /metrics` — Prometheus metrics
- `GET /api/v1/stats` — system stats
- `GET /api/v1/audit` — audit log query
- `GET /api/v1/tokens` / per-agent / config / reset — token budget
- `GET/POST/DELETE /api/v1/keys` — API key management
- `GET /api/v1/skills` / reload / config — skill management
- `GET/POST /api/v1/pipelines` / execute — pipeline management

**Bridge (federation):**
- `GET /api/v1/bridge/status`
- `GET/POST/DELETE /api/v1/bridge/peers`
- `GET /api/v1/bridge/agents`
- `POST /api/v1/bridge/agents/:id/messages`

**WebSocket (ws.ts):**
- Subscribe/unsubscribe to agent events
- Events: `agent:processing`, `agent:tool-call`, `agent:response`, `agent:error`, `agent:idle`

### 3.2 API Gaps for Frontend Support

| Gap | Priority | Notes |
|-----|----------|-------|
| **Authentication system** | Critical | No login/signup/JWT. Need user management for multi-user dashboard |
| **Session message history** | Critical | Can list sessions but not retrieve messages within a session |
| **File upload endpoint** | High | No multipart upload support |
| **Conversation list (cross-agent)** | High | Need unified conversation view across agents |
| **User preferences** | Medium | Theme, model defaults, notification settings |
| **WebSocket auth** | Medium | WS has no auth, only REST has API key |
| **Search (cross-session)** | Medium | Full-text search across conversations |
| **Agent logs/trace viewer** | Medium | Tool call details, reasoning traces for debugging |
| **Notification preferences** | Low | Push notification subscription management |
| **Rate limit headers** | Low | Return `X-RateLimit-*` headers for client awareness |

---

## 4. Recommended Architecture

### 4.1 Approach: **Adapt, Don't Fork**

**Recommendation:** Build a custom Next.js dashboard inspired by Lobe Chat's patterns, NOT fork an existing project.

**Why not fork:**
- Every existing UI has its own backend (Ollama, LangChain, etc.) — we'd rip out 70% of the code
- Anorion's gateway is already a comprehensive backend — we just need a frontend
- Existing UIs don't have agent management, pipeline editing, token budgets, audit logs
- Maintenance burden of diverging from upstream

**What to borrow:**
- Lobe Chat's UI component patterns (chat bubbles, markdown rendering, code highlighting)
- LibreChat's multi-provider model selector pattern
- Open WebUI's admin panel and RAG upload UX

### 4.2 Architecture Diagram

```
┌─────────────────────────────────────────────┐
│                 Frontends                     │
│                                               │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Web Dashboard│  │  Mobile App          │  │
│  │  (Next.js 15) │  │  (React Native/Expo) │  │
│  │              │  │                      │  │
│  │  - Chat UI   │  │  - Chat              │  │
│  │  - Agent Mgmt│  │  - Push notifications│  │
│  │  - Pipelines │  │  - Quick actions     │  │
│  │  - Audit     │  │  - Voice input       │  │
│  │  - Skills    │  │                      │  │
│  └──────┬───────┘  └──────────┬───────────┘  │
│         │                     │               │
│         │   Shared API Client │               │
│         │   (@anorion/client) │               │
│         └──────────┬──────────┘               │
└────────────────────┼──────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │   Anorion Gateway     │
         │   (Hono on Node.js)   │
         │                       │
         │  REST API  +  WS/SSE  │
         └───────────┬───────────┘
                     │
         ┌───────────┴───────────┐
         │   Agent Runtime       │
         │   (LLM + Tools +      │
         │    Memory + Channels)  │
         └───────────────────────┘
```

### 4.3 Web Dashboard — Next.js 15

**Tech Stack:**
- Next.js 15 (App Router, Server Components)
- React 19
- Tailwind CSS + shadcn/ui (same as Lobe Chat pattern)
- Zustand for state management
- `@anorion/client` — shared TypeScript API client

**Pages/Routes:**
```
/                       → Dashboard overview (stats, active agents, recent activity)
/chat                   → Chat interface (select agent, conversation)
/chat/[agentId]         → Chat with specific agent
/chat/[agentId]/[sid]   → Resume specific session
/agents                 → Agent management (CRUD, config)
/agents/[id]            → Agent detail (config, memory, sessions, logs)
/pipelines              → Pipeline builder (visual editor)
/tools                  → Tool registry
/skills                 → Skill management
/monitoring             → Metrics, audit logs, token budgets
/settings               → User preferences, API keys
```

**Key Features:**
- Real-time streaming chat with SSE
- WebSocket subscription for live agent status
- Agent config editor (system prompt, tools, model selection)
- Pipeline visual builder (drag-and-drop)
- Memory browser/editor per agent
- Audit log viewer with filters
- Token budget monitoring
- Dark/light theme

### 4.4 Mobile App — React Native (Expo)

**Phase 1: PWA (quick win)**
- Make the web dashboard fully responsive
- Add PWA manifest for home screen install
- Service worker for offline message queue

**Phase 2: React Native / Expo**
- Expo Router for navigation
- Shared `@anorion/client` package
- Core features: chat, push notifications, voice input
- Biometric auth
- Share extension (send to Anorion)

### 4.5 Shared API Client (`@anorion/client`)

```typescript
// packages/client/src/index.ts
export class AnorionClient {
  constructor(baseUrl: string, apiKey: string) { ... }
  
  // Agents
  agents: {
    list(): Promise<Agent[]>
    get(id: string): Promise<Agent>
    create(data: CreateAgentInput): Promise<Agent>
    update(id: string, data: UpdateAgentInput): Promise<Agent>
    delete(id: string): Promise<void>
  }
  
  // Chat
  chat: {
    send(agentId: string, text: string, opts?: ChatOptions): Promise<ChatResponse>
    stream(agentId: string, text: string, opts?: ChatOptions): AsyncIterable<StreamEvent>
  }
  
  // Sessions
  sessions: {
    list(agentId: string): Promise<Session[]>
    getMessages(sessionId: string): Promise<Message[]>  // GAP - needs backend
  }
  
  // Memory
  memory: {
    list(agentId: string): Promise<Memory[]>
    save(agentId: string, key: string, value: any): Promise<Memory>
    search(agentId: string, query: string): Promise<Memory[]>
    delete(agentId: string, key: string): Promise<void>
  }
  
  // WebSocket
  ws: {
    connect(): WebSocket
    subscribe(agentIds: string[]): void
    unsubscribe(agentIds: string[]): void
    onEvent(handler: (event: AgentEvent) => void): () => void
  }
  
  // ... tools, channels, schedules, pipelines, etc.
}
```

---

## 5. Gateway API Enhancements Needed

### Phase 1 (Required for MVP frontend):

```typescript
// Authentication
POST   /api/v1/auth/login          → { token, user }
POST   /api/v1/auth/register       → { token, user }
GET    /api/v1/auth/me             → { user }
POST   /api/v1/auth/refresh        → { token }

// Session history (GAP)
GET    /api/v1/sessions/:sessionId/messages?before=&limit=  → { messages, hasMore }

// File upload (GAP)
POST   /api/v1/upload              → multipart, returns file URL

// Message attachments
// Extend SendMessageSchema with optional attachments[] field
```

### Phase 2 (Enhanced features):

```typescript
// Cross-agent search
GET    /api/v1/search?q=&agentId=&sessionId=  → { results }

// Agent logs / traces
GET    /api/v1/agents/:id/logs?since=&limit=  → { logs }
GET    /api/v1/agents/:id/traces/:traceId     → { trace }

// User preferences
GET    /api/v1/preferences         → { preferences }
PATCH  /api/v1/preferences         → { preferences }

// Notification subscriptions
POST   /api/v1/notifications/register-token   → push notification device token
```

### Phase 3 (Advanced):

```typescript
// WebSocket auth upgrade (include token in query or first message)
// Rate limit headers in responses
// Cursor-based pagination for all list endpoints
// Batch operations (e.g., send to multiple agents)
```

---

## 6. Implementation Plan

### Phase 1: Web Dashboard MVP (Weeks 1-3)

**Week 1: Foundation**
- [ ] Create monorepo: `packages/client`, `packages/ui`, `apps/web`
- [ ] Implement `@anorion/client` with all existing API endpoints
- [ ] Set up Next.js 15 + shadcn/ui + Tailwind
- [ ] Build auth flow (login page → API key input for MVP, JWT later)

**Week 2: Chat**
- [ ] Chat interface with SSE streaming
- [ ] Markdown rendering + code highlighting
- [ ] Agent selector dropdown
- [ ] Session management (new/resume)
- [ ] WebSocket connection for real-time status

**Week 3: Management**
- [ ] Agent CRUD pages
- [ ] Dashboard overview (stats, active agents)
- [ ] Memory browser per agent
- [ ] Tool registry view
- [ ] Basic responsive layout

### Phase 2: Gateway Enhancements (Weeks 2-4, parallel)

- [ ] JWT authentication middleware
- [ ] Session message history endpoint
- [ ] File upload endpoint
- [ ] CORS configuration for frontend origin
- [ ] WebSocket authentication
- [ ] Rate limit response headers

### Phase 3: Enhanced Dashboard (Weeks 4-6)

- [ ] Pipeline visual builder
- [ ] Audit log viewer
- [ ] Token budget monitoring
- [ ] Skill management UI
- [ ] Schedule management UI
- [ ] Bridge/federation status
- [ ] Dark/light theme

### Phase 4: Mobile (Weeks 6-10)

- [ ] Make web dashboard fully responsive + PWA
- [ ] Expo React Native app scaffold
- [ ] Chat feature (reuse client)
- [ ] Push notifications (FCM/APNs)
- [ ] Voice input (expo-speech)
- [ ] Share extension

### Phase 5: Polish (Weeks 10-12)

- [ ] Full-text search across conversations
- [ ] Agent trace/debugger view
- [ ] Keyboard shortcuts
- [ ] Export conversations
- [ ] User onboarding flow

---

## 7. Summary Comparison

| Project | Tech | Best For | Fork? |
|---------|------|----------|-------|
| **Open WebUI** | SvelteKit + Python | Self-hosted Ollama UI | ❌ Python backend mismatch |
| **Lobe Chat** | Next.js + React | Modern multi-model chat | ⭐ Borrow patterns/components |
| **LibreChat** | React + Express + Mongo | ChatGPT clone | ❌ Overlaps with gateway, but good reference |
| **Chatbot UI** | Next.js + Supabase | Simple chat | ❌ Too simple |
| **Chainlit** | Python + React | Rapid Python agent UI | ❌ Python-first, archived maintainer |
| **Flowise** | Node + React | Visual flow builder | ⭐ Pipeline builder reference |
| **OpenCode/Crush** | Go TUI | Terminal coding agent | ❌ Different form factor |

**Final recommendation:** Build a custom Next.js dashboard using shadcn/ui, heavily inspired by Lobe Chat's design patterns and component architecture. Create a shared `@anorion/client` TypeScript package used by both web and mobile. Start with PWA for mobile, graduate to React Native/Expo when needed.

The gateway API is already well-structured for frontend consumption — the main gaps are authentication, session message history, and file upload.
