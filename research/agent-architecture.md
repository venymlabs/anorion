# Agent Framework Architecture Research

> Competitive analysis for Anorion — April 2025
>
> Frameworks analyzed: OpenClaw, AutoGPT, CrewAI, LangGraph, Semantic Kernel, Mastra, Hermes, Pydantic AI / OpenAI Agents SDK, Eliza, Dify

---

## Table of Contents

1. [Anorion Current State](#1-anorion-current-state)
2. [Framework Analyses](#2-framework-analyses)
3. [Cross-Cutting Pattern Analysis](#3-cross-cutting-pattern-analysis)
4. [Recommendations for Anorion](#4-recommendations-for-anorion)

---

## 1. Anorion Current State

### Architecture Overview

```
src/
├── agents/          # Runtime, sessions, pipeline, subagent, registry
├── bridge/          # Multi-instance federation (federator, protocol)
├── channels/        # Channel adapters (base, telegram, webhook, router)
├── tools/           # Tool registry, executor, skill-manager, builtins
├── memory/          # Memory store (SQLite+LRU), context compaction
├── gateway/         # Hono HTTP server, SSE streaming, WebSocket
├── llm/             # Provider abstraction (multi-model support)
├── scheduler/       # Cron-based task scheduling
├── shared/          # Config, DB, events, logger, metrics, RBAC, audit
├── cli/             # CLI interface
└── plugins/         # Plugin system
```

### Strengths
- Clean modular architecture with clear separation of concerns
- AI SDK v6 integration with `stepCountIs` agentic loop
- Multi-channel abstraction (Telegram, webhook, extensible)
- Bridge/federation for horizontal scaling
- Context compaction for long conversations
- Event-driven architecture with event bus
- Token budget enforcement and metrics

### Gaps Identified
- No graph-based workflow engine (only linear pipelines)
- No checkpointing/state persistence for long-running workflows
- No human-in-the-loop patterns
- No structured output validation
- Memory is flat key-value (no vector search/RAG)
- No inter-agent handoff protocol
- No guardrails/validation layer
- No built-in tracing/observability spans
- Tool system lacks composability (no tool chains, middleware)
- No workflow-level retry/saga patterns

---

## 2. Framework Analyses

### 2.1 OpenClaw

**Source**: Local docs at `/home/d/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/docs/`

**Agentic Loop**: Serialized run architecture with sophisticated queue management:

```
Gateway RPC → agentCommand → runEmbeddedPiAgent → subscribeEmbeddedPiSession
                                    ↓
                          Session queue serialization
                         (one run per session at a time)
```

**Queue Modes** (when a new message arrives during an active run):
- `steer`: Interrupt current run, inject new message
- `followup`: Queue the message, process after current run
- `collect`: Coalesce multiple queued messages into one run

**Tool System**: Plugin-based with TypeBox schemas:
```typescript
export default function(api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  }, { optional: true });
}
```
- Per-agent tool allowlists/denylists with wildcard support
- Plugin hook system: `before_tool_call`, `after_tool_call`, `tool_result_persist`
- Lifecycle hooks: `before_agent_start`, `agent_end`, `message_received`, `message_sending`, `message_sent`

**Memory**: Hybrid BM25 + vector search:
- Split into ~400 token chunks with 80-token overlap
- Local embeddings (GGUF via node-llama-cpp) or remote (OpenAI, Gemini, Voyage)
- Workspace-as-memory: Git-backed workspace with `MEMORY.md`, daily logs in `memory/YYYY-MM-DD.md`
- Auto memory flush before compaction (configurable token threshold)

**Session Management**:
- JSONL transcripts at `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- Session keys: `agent:<id>:main`, `agent:<id>:<channel>:group:<id>`, thread support
- Bootstrap from workspace files (AGENTS.md, SOUL.md)
- Compaction with soft-trim (head+tail) and hard-clear (placeholder) strategies
- Cache-TTL-aware: only clear after Anthropic cache expires

**Channel Routing**: Deterministic binding with specificity cascade:
1. Exact peer match
2. Parent peer inheritance
3. Guild + roles (Discord)
4. Guild/Team match → Account match → Channel match → Default agent

**Streaming**: Block streaming with smart chunk boundaries:
- Break preference: paragraph → newline → sentence → whitespace
- Code fences: never split inside (close/reopen if forced)
- Idle-based coalescing with configurable thresholds
- Telegram preview: sendMessage + editMessageText with partial/block/off modes

**Key Patterns**:
- Session lane serialization with steer/followup/collect queue modes
- Hybrid BM25 + vector search for memory retrieval
- Plugin hook system with before/after tool call interception
- Block streaming with intelligent chunk boundaries
- Auto memory flush before compaction
- Workspace-as-memory (Git-backed files)

### 2.2 Hermes Agent

**Source**: Local codebase at `/home/d/hermes-agent/`

**Agentic Loop**: Sophisticated iteration system with `IterationBudget` (thread-safe, shared across parent/child agents). Default 90 max iterations. Supports interrupt handling and concurrent tool execution.

```python
while api_call_count < max_iterations and iteration_budget.remaining > 0:
    if interrupt_requested: break
    response = _interruptible_api_call(api_kwargs)
    if assistant_message.tool_calls:
        _execute_tool_calls(assistant_message, messages, task_id)
    else:
        final_response = assistant_message.content
```

**Multi-Agent**: Delegate tool spawns child agents with:
- Depth limiting (max 2 levels)
- Concurrent execution (up to 3 children)
- Tool restriction (blocked dangerous tools for children)
- Shared iteration budget across hierarchy

**Memory**: Dual file-based system — `MEMORY.md` (agent's notes, 2200 chars) and `USER.md` (user profile, 1375 chars). Entries delimited by `§`. Frozen snapshot pattern for stable system prompt caching.

**Unique Patterns**:
- **Self-improvement loop**: Agents create and improve skills from experience
- **Nudge-based interaction**: Periodic prompts to save memories after complex tasks
- **Prompt caching**: Stable system prompt prefix with ephemeral session additions
- **Zero-context-cost RPC**: `execute_code` tool refunds iterations for programmatic calls
- **Checkpoint system**: Snapshots before file mutations with rollback
- **Hybrid memory access**: First turn baked into cached prompt, later turns as tool responses
- **6 terminal backends**: local, Docker, SSH, Daytona, Singularity, Modal

### 2.3 AutoGPT / AgentGPT

**Agentic Loop**: The Forge SDK provides a Plan-Execute-Observe cycle:

```
User Task → Agent Loop:
  1. Read task & context from memory
  2. Send to LLM with available tools
  3. Parse LLM response (reasoning + tool calls)
  4. Execute tool calls
  5. Store results in memory
  6. Check stopping conditions
  7. If not done → repeat from step 1
→ Return final result
```

**Planning**: Workspace-based architecture where the agent maintains a persistent workspace. Tasks decomposed into sub-tasks with dependencies. Uses a protocol-based approach where the agent proposes actions that are validated before execution.

**Memory Architecture**:
- Short-term: Conversation context window
- Long-term: JSON file storage + vector database integration
- Working memory: Current task state and scratchpad

**Unique Patterns**:
- Workspace abstraction for file/state persistence
- Protocol-based action validation
- Self-correction through reflection loops
- Benchmark suite for measuring agent capabilities

### 2.4 CrewAI

**Multi-Agent Orchestration**: Role-based agent design where each agent has:
- `role`: Functional description (e.g., "Research Analyst")
- `goal`: Objective description
- `backstory`: Context for the LLM to adopt the persona
- `tools`: Agent-specific tool set

**Workflow Patterns**:

| Pattern | Description |
|---------|-------------|
| **Sequential** | Tasks run one after another, output of one feeds into next |
| **Hierarchical** | Manager agent delegates tasks to worker agents |
| **Parallel** | Multiple agents work on independent tasks simultaneously |
| **Flows** | Graph-based workflow with conditional routing and state |

**CrewAI Flows** (2025): A graph-based workflow system where:
- `@start()` decorators mark entry points
- `@listen()` decorators create edges between methods
- `@router()` decorators for conditional branching
- State flows through typed router classes
- Supports fan-out/fan-in patterns
- `@listen("method_name", "method_name2")` for joining multiple upstream outputs

```python
class MyFlow(Flow):
    @start()
    def generate_topic(self):
        return {"topic": "AI Agents"}

    @listen("generate_topic")
    def write_article(self, state):
        return {"article": "..."}

    @listen("write_article")
    def review_article(self, state):
        return {"review": "LGTM"}
```

**Memory**: Shared memory across agents with:
- Short-term: Per-task context
- Long-term: Cross-session persistence
- Entity memory: Extracted entities and relationships
- User memory: Per-user preference tracking

**Key Patterns**:
- Role-based agent personas with backstory injection
- Flows as graph-based workflow DSL
- Shared memory layers with entity extraction
- Manager-worker delegation pattern

### 2.5 LangGraph

**Architecture**: State machines for agents using directed graphs. Core abstractions:

```typescript
// TypeScript (LangGraph.js)
const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  context: Annotation<string>,
});

const graph = new StateGraph(GraphState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");
```

**Key Abstractions**:
- **Nodes**: Functions that receive state and return partial state updates
- **Edges**: Static or conditional transitions between nodes
- **State**: Typed with `Annotation.Root()` and custom reducers
- **ToolNode**: Special node for tool execution

**Checkpointing**: The most sophisticated state persistence in any framework:
- Saves full graph state at every step
- Supports pause/resume from any checkpoint
- Time-travel debugging (replay from any point)
- Backends: MemorySaver, SqliteSaver, PostgresSaver, Redis

**Human-in-the-Loop** (3 mechanisms):

1. **`interrupt_before` / `interrupt_after`** — Pause before/after specific nodes:
```typescript
const app = graph.compile({
  checkpointer: memoryCheckpointer,
  interruptBefore: ["human_review_node"]
});
```

2. **`NodeInterrupt`** — Dynamic interrupt from within a node:
```typescript
function reviewNode(state) {
  if (state.requires_approval) {
    throw new NodeInterrupt("Awaiting human approval");
  }
  return state;
}
```

3. **State Update + Resume** — Human modifies state, then execution resumes:
```typescript
// Human updates state
await app.updateState(config, { approved: true }, "human_review_node");
// Resume execution
const result = await app.invoke(null, config);
```

**Streaming** (3 modes):

| Mode | What it streams |
|------|----------------|
| `"values"` | Full state after each node |
| `"updates"` | Only the delta (node output) |
| `"messages"` | Token-by-token LLM output |

**Architecture Patterns**:

| Pattern | Description |
|---------|-------------|
| **ReAct Agent** | Standard reasoning + acting loop |
| **Supervisor** | Manager agent routes between specialized subgraphs |
| **Map-Reduce** | Fan-out/fan-in for parallel processing |
| **Subgraph** | Nested StateGraphs for composition |

**Key Patterns**:
- Graph as the core abstraction (not agents)
- State reducers for merging partial updates
- Checkpointing for persistence and time-travel
- Conditional edges for dynamic routing
- Subgraph composition for modularity

### 2.6 Semantic Kernel (Microsoft)

**Architecture**: Plugin-based orchestration with the Kernel as the central object:

```csharp
var kernel = Kernel.CreateBuilder()
    .AddAzureOpenAIChatCompletion(...)
    .Build();

// Plugins = functions + prompt templates
kernel.ImportPluginFromType<WeatherPlugin>();
kernel.ImportPluginFromPromptDirectory("prompts/");
```

**Plugin System**: Three types of plugins:
1. **Native functions**: C#/Python methods auto-wrapped with schema
2. **Prompt functions**: Prompt templates that invoke LLM
3. **API plugins**: OpenAPI/Swagger integration

**Planning**:
- **Handlebars Planner**: Generates Handlebars templates as plans
- **Stepwise Planner**: Iterative plan-execute-observe loop
- **Function Calling** (recommended): Auto orchestration via tool calls — the LLM decides which functions to call and the kernel handles the cycle automatically. The older planners are deprecated in favor of this approach.

**Auto-Function-Calling Loop**:
```python
# The kernel automatically handles:
# 1. LLM sees available function plugins
# 2. LLM decides to call a function
# 3. Kernel executes the function
# 4. Result feeds back to LLM
# 5. Repeat until LLM produces final answer
# All automatic — no manual orchestration code needed.
```

**Memory**:
- `IVectorStore` abstraction over multiple backends (Azure AI Search, Qdrant, Pinecone, Redis, Chroma)
- Record definitions with `[VectorStoreRecordKey]`, `[VectorStoreRecordData]`, `[VectorStoreRecordVector]` attributes
- `KernelArguments` for variable passing between pipeline steps

**Key Patterns**:
- Kernel as dependency injection container
- Automatic function schema generation from type signatures
- Handlebars-based plan templates
- Unified vector store abstraction

### 2.7 Mastra

**Architecture**: TypeScript-first agent framework with:

```typescript
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const weatherTool = createTool({
  id: "getWeather",
  description: "Get weather for a location",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ temp: z.number() }),
  execute: async ({ context }) => { /* ... */ },
});

const agent = new Agent({
  name: "assistant",
  instructions: "You are a helpful assistant",
  model: openai("gpt-4o"),
  tools: { weatherTool },
});
```

**Tool System**: Zod-validated input/output schemas with `createTool()`. Key design decisions:
- **Zod-first**: Input and output schemas use Zod, providing TypeScript type inference at the tool boundary. Framework handles Zod-to-JSON-Schema conversion for the LLM.
- **`toModelOutput` transform**: A tool can return rich structured data for the application but transform it before feeding back to the model context, keeping the context window focused. This is a distinct pattern from returning tool results as-is.
- **Named tool binding**: Tools are passed as `tools: { weatherTool }` object literals, where the object key determines the `toolName` in stream responses.

**Workflow Engine**: Step-based workflows with fluent API:

```typescript
const step1 = createStep({
  id: 'step-1',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ formatted: z.string() }),
  execute: async ({ inputData }) => ({ formatted: inputData.message.toUpperCase() }),
});

const workflow = createWorkflow({
  id: 'test-workflow',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ output: z.string() }),
})
  .then(step1)
  .commit();
```

Key features:
- Steps have typed `inputSchema`/`outputSchema` enabling type-safe chaining
- `.then()` / `.commit()` fluent API for composition
- **Suspend/resume**: Workflows suspend mid-execution and resume later (human-in-the-loop)
- **Discriminated result union**: `result.status` is `'success' | 'failed' | 'suspended' | 'tripwire' | 'paused'`
- Workflows can be nested inside other workflows
- Workflows registered on agents auto-convert to tools named `workflow-<key>`

**Memory System** (4-tier):
1. **Message history**: `resource` (user ID) + `thread` (conversation ID) scoping
2. **Observational Memory**: Background agents compress old messages into dense observations, replacing raw history as it grows. Two phases: *Observer* (compresses messages) and *Reflector* (generates higher-level reflections)
3. **Working memory**: Persistent structured user data (names, preferences, goals)
4. **Semantic recall**: Retrieves relevant past messages via embedding similarity

Multi-agent memory isolation: Each supervisor delegation creates a fresh `threadId` and deterministic `resourceId`. Resource-scoped sharing defaults to `scope: 'resource'`, thread-scoped to `scope: 'thread'`.

**Structured Output**: Agents return typed objects matching Zod schemas with:
- Error strategies: `'strict'` (throw), `'warn'` (log + continue), `'fallback'` (return fallback values)
- Separate structuring model: Use a second LLM for structuring when the main model struggles
- `jsonPromptInjection: true`: Fallback for models without `response_format` support

**Key Patterns**:
- TypeScript-native with Zod validation
- `toModelOutput` for controlling what returns to model context
- 4-tier memory with observational compression
- Suspend/resume workflows with discriminated results
- Dynamic memory via `RequestContext` functions
- `'provider/model'` string-based model routing

### 2.8 Pydantic AI / OpenAI Agents SDK

**Pydantic AI**: Typed agent patterns in Python with full generic type safety:

```python
from pydantic_ai import Agent, RunContext, ModelRetry

agent = Agent(
    'openai:gpt-4o',
    deps_type=SupportDependencies,    # Generic dependency type
    output_type=SupportOutput,         # Generic result type
    instructions='You are a support agent...',
)

@agent.system_prompt
async def add_context(ctx: RunContext[SupportDependencies]) -> str:
    return f"User: {ctx.deps.user_name}"

@agent.tool
async def lookup_customer(ctx: RunContext[SupportDependencies], user_id: int) -> Customer:
    user = await ctx.deps.db.get_user(user_id)
    if user is None:
        raise ModelRetry(f'User {user_id} not found, try another ID')
    return user

result = await agent.run("Help me", deps=SupportDependencies(...))
# result.data is typed as SupportOutput
```

**Key Patterns**:
- **`Agent[DepsType, OutputType]` generics**: Full type safety through the agent loop — mypy/pyright catch type errors at definition sites
- **Dependency injection**: `deps_type` parameter injects typed services. Same agent definition runs with different deps in different contexts (database connections, API clients)
- **`RunContext[DepsType]`**: Type-safe context passed to all hooks — tool functions, system prompts, result validators
- **`ModelRetry` self-correction**: Tools raise `ModelRetry` to signal the LLM to retry with different parameters, without counting as a tool failure. Elegant self-correction loop
- **Capabilities system**: Composable extensions (`Thinking()`, `WebSearch()`) that add tools and modify behavior, cleaner than flat tool arrays
- **Model-agnostic**: `'provider:model'` string format works with OpenAI, Anthropic, Gemini, Ollama
- **Usage limits**: `response_tokens_limit`, `request_limit`, `tool_calls_limit` — configurable budgets per run

**Execution model**: Uses `pydantic-graph` FSM internally:
```
UserPromptNode → ModelRequestNode → CallToolsNode → End
                    ^                      |
                    |______________________|
```
Five run modes: `.run()`, `.run_stream()`, `.iter()` (graph iterator), `.run_sync()`, and node-by-node manual iteration.

**OpenAI Agents SDK** (March 2025):

```python
from agents import Agent, Runner, GuardrailFunctionOutput, input_guardrail

agent = Agent(
    name="Triage",
    instructions="Route to the right agent",
    handoffs=[billing_agent, support_agent],
    tools=[lookup_tool],
)

result = await Runner.run(agent, messages=conversation)
```

**Architecture**:
```
Runner → Agent (LLM + Tools + Handoffs) → Agent (LLM + Tools) → Output
  │                                           │
  ├── Input Guardrails                        ├── Input Guardrails
  ├── Tracing (span)                          ├── Tracing (span)
  └── Output Guardrails                       └── Output Guardrails
```

**Handoffs**: Agents transfer control via special tool calls intercepted by the SDK:
- Handoffs appear as tools named `transfer_to_<agent_name>` that the LLM can invoke
- `input_filter`: Controls what conversation history the receiving agent sees (e.g., `remove_all_tools` strips tool calls)
- `input_type`: Pydantic model for typed handoff arguments (reason, priority)
- `on_handoff`: Callback for pre-fetching data before handoff
- `is_enabled`: Dynamic enable/disable per request
- Nested handoff history: Collapses prior transcript into summary `<CONVERSATION_HISTORY>` blocks

**Guardrails** (3 types):
1. **Input guardrails**: Run on first agent input. `run_in_parallel=True` (default) runs concurrently with agent for lower latency; `False` blocks agent until guardrail passes
2. **Output guardrails**: Run on final agent output. Tripwire pattern
3. **Tool guardrails**: Run on every function-tool invocation. Can `allow()`, `reject_content()`, or `skip()` the tool call entirely

```python
@tool_input_guardrail
def block_secrets(data):
    if "sk-" in data.context.tool_arguments:
        return ToolGuardrailFunctionOutput.reject_content("Remove secrets first.")
    return ToolGuardrailFunctionOutput.allow()
```

**Tracing**: First-class built-in observability:
- **Traces** (end-to-end workflows) composed of **Spans** (operations)
- Default spans: `agent_span`, `generation_span`, `function_span`, `guardrail_span`, `handoff_span`
- `BatchTraceProcessor` sends to OpenAI backend; `add_trace_processor()` for custom backends
- 30+ integrations: Langfuse, LangSmith, MLflow, W&B, Arize-Phoenix
- Context var tracking for automatic concurrency safety

**Key Patterns**:
- Agents as the primary primitive (not graphs)
- Handoffs over orchestration (agents decide when to delegate)
- Guardrails as composable validation layers with parallel/blocking modes
- Tool-level guardrails for data safety
- Tracing built-in by default with span hierarchy
- Runner as the execution orchestrator
- `ModelRetry` for graceful self-correction

### 2.9 Eliza (elizaOS)

**Architecture**: Character-driven multi-channel agent framework. Core types:

```typescript
// Character = agent definition
interface Character {
  name: string;
  username: string;
  bio: string[];
  lore: string[];
  messageExamples: MessageExample[][];
  postExamples: string[];
  topics: string[];
  style: { all: string[]; chat: string[]; post: string[] };
  adjectives: string[];
  plugins: Plugin[];
}

// Action = tool equivalent
interface Action {
  name: string;
  description: string;
  examples: ActionExample[][];
  handler: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<any>;
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
}

// Evaluator = post-processing hook
interface Evaluator {
  name: string;
  description: string;
  examples: EvaluatorExample[][];
  handler: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<void>;
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
}
```

**Agent Loop**:
1. Receive message from channel
2. `composeState()` — gather context (messages, memories, relationships, knowledge)
3. Execute actions (tool calls)
4. Run evaluators (post-processing: fact extraction, memory update)
5. Generate response with LLM
6. Send response through channel

**Memory System**:
- `Memory` type: `{ id, content, embedding, roomId, userId, createdAt }`
- Multiple memory types: messages, documents, descriptions, facts
- Vector similarity search for retrieval
- Relationship tracking between entities

**Multi-Channel**: Platform adapters for Discord, Telegram, Twitter, and more. Channel directory maintains cached mapping of reachable channels/contacts.

**Plugin System**: Plugins provide actions, evaluators, providers, services, and routes. Loaded at runtime.

**Key Patterns**:
- Character/persona as the agent definition
- Action + Evaluator pattern (execute + post-process)
- Vector-based memory with relationship tracking
- Plugin as the unit of extensibility
- Provider pattern for context injection

### 2.10 Dify

**Architecture**: Visual agent builder with a DSL backend. Workflows are defined as node graphs:

```
[Start] → [LLM Node] → [Condition] → [Tool Node] → [End]
                                    → [Human Input] → [LLM Node] → [End]
```

**Key Abstractions**:
- **Nodes**: LLM call, tool call, code execution, condition, variable assignment, HTTP request, template transform
- **Edges**: Connections with variable mapping
- **Variables**: Typed variables passed between nodes
- **Conversational Variables**: Persistent across turns

**Workflow Execution**:
1. Start node receives input
2. Graph executor traverses nodes in topological order
3. Each node reads from input variables, writes to output variables
4. Conditional nodes create branching paths
5. Parallel nodes execute concurrently
6. End node returns final output

**Visual → Code Mapping**: Dify's visual DSL maps to a JSON representation that defines the graph structure. This is essentially a serialized state machine.

**Key Patterns**:
- Node-based visual DSL
- Variable passing between nodes with type checking
- Built-in nodes for common operations (LLM, code, HTTP, condition)
- Conversational variables for multi-turn persistence
- Parallel execution with fork/join

---

## 3. Cross-Cutting Pattern Analysis

### 3.1 Agentic Loop Designs

| Framework | Loop Pattern | Tool Execution | Max Iterations |
|-----------|-------------|----------------|----------------|
| **Anorion** | AI SDK `stepCountIs` | Sequential (SDK handles) | Configurable (default 10) |
| **OpenClaw** | Session lane serialization | Sequential per lane | Configurable (600s timeout) |
| **Hermes** | while-loop + IterationBudget | Concurrent (thread pool) | 90 |
| **LangGraph** | Graph traversal | ToolNode | Unlimited (graph cycles) |
| **OpenAI SDK** | Runner loop | Sequential | Configurable |
| **Eliza** | Action→LLM→Evaluator | Sequential | Configurable |

**Best Pattern**: LangGraph's graph-based approach is most flexible — it allows arbitrary cycles, conditional routing, and doesn't require a fixed iteration count. Hermes's shared IterationBudget for parent/child agents is also excellent for preventing runaway costs.

### 3.2 Multi-Agent Orchestration

| Framework | Pattern | Communication | Composition |
|-----------|---------|--------------|-------------|
| **Anorion** | Pipeline, SubAgent, Bridge | Message passing | Linear chains |
| **CrewAI** | Role-based crews | Shared memory | Sequential/Hierarchical/Flows |
| **LangGraph** | Supervisor subgraphs | State passing | Subgraph nesting |
| **OpenAI SDK** | Handoffs | Conversation forwarding | Agent lists |
| **Hermes** | Delegate tool | Parent→child summary | Depth-limited |
| **Eliza** | Character switching | Shared runtime | Plugin-based |

**Best Pattern**: OpenAI SDK's handoff pattern is the most elegant — agents declare which other agents they can hand off to, and the SDK handles the routing. LangGraph's supervisor pattern is more powerful but more complex. Anorion should adopt both: simple handoffs for common cases, graph-based workflows for complex orchestration.

### 3.3 Memory/Context Management

| Framework | Short-term | Long-term | Retrieval |
|-----------|-----------|-----------|-----------|
| **Anorion** | Session messages | SQLite key-value | FTS5 text search |
| **Hermes** | Conversation history | MEMORY.md / USER.md files | Full-text scan |
| **LangGraph** | Graph state | Checkpointing | State traversal |
| **Eliza** | Message history | Vector embeddings | Similarity search |
| **CrewAI** | Task context | Entity + User memory | Vector + structured |
| **Semantic Kernel** | KernelArguments | Vector store | Embedding search |

**Best Pattern**: Eliza's multi-type memory system (messages, documents, facts, relationships) with vector similarity search is the most comprehensive. CrewAI's layered approach (short-term + long-term + entity + user) is also strong. Anorion needs to evolve from flat key-value to at least support vector search for semantic retrieval.

### 3.4 Tool/Plugin Systems

| Framework | Definition | Validation | Composability |
|-----------|-----------|------------|--------------|
| **Anorion** | ToolDefinition interface | JSON Schema | Bind to agent |
| **Mastra** | `createTool()` + Zod | Zod schemas | N/A |
| **Semantic Kernel** | Method attributes | Auto-inferred | Plugin import |
| **Eliza** | Action + validate fn | Runtime validate | Plugin system |
| **LangGraph** | LangChain tools | Pydantic/Zod | ToolNode |
| **OpenAI SDK** | Function wrapping | Auto-inferred | Per-agent |

**Best Pattern**: Mastra's Zod-validated tools with explicit input/output schemas provide the best TypeScript developer experience. Eliza's `validate()` function on actions is a nice safety layer. Anorion should add Zod validation and a middleware/hook system for tools.

### 3.5 Streaming Architecture

| Framework | Token-level | Event-level | Channel-aware |
|-----------|------------|------------|--------------|
| **Anorion** | SSE delta events | Tool call/result events | Yes (Telegram edits) |
| **LangGraph** | Multiple stream modes | Node transitions | No |
| **Eliza** | Text chunks | Action/Evaluator events | Yes (multi-platform) |
| **Hermes** | Content deltas | Tool progress callbacks | Yes (TTS pipeline) |

**Best Pattern**: Anorion is already strong here. The main gap is structured streaming events (LangGraph-style) and middleware-based stream processing.

### 3.6 Error Handling and Resilience

| Framework | Retry | Fallback | Circuit Breaker |
|-----------|-------|----------|----------------|
| **Anorion** | Exponential backoff | Fallback model | Token budget |
| **Hermes** | Per-error-type retry | Checkpoint rollback | Iteration budget |
| **LangGraph** | Checkpoint recovery | State rewind | N/A |
| **OpenAI SDK** | Runner retry | N/A | Guardrails |
| **CrewAI** | Task retry | Delegate to other agent | N/A |

**Best Pattern**: Anorion's error categorization + fallback model is already solid. Hermes's checkpoint-before-mutation pattern and LangGraph's full state checkpointing are worth adopting for reliability.

---

## 4. Recommendations for Anorion

### P0 — Critical (Ship Immediately)

#### 4.1 Graph-Based Workflow Engine

**Why**: Linear pipelines are insufficient for complex multi-agent workflows. Every major framework (LangGraph, CrewAI Flows, Dify) has adopted graph-based orchestration. Without this, Anorion cannot express branching, conditional routing, or parallel fan-out/fan-in.

**Design**:

```typescript
// src/workflow/graph.ts
import { z } from "zod";

interface GraphState<T extends Record<string, any>> {
  values: T;
  history: StateSnapshot[];
}

class StateGraph<T extends Record<string, any>> {
  private nodes = new Map<string, GraphNode<T>>();
  private edges = new Map<string, EdgeDef<T>>();

  addNode(name: string, fn: (state: T) => Promise<Partial<T>>): this;
  addEdge(from: string, to: string): this;
  addConditionalEdges(from: string, condition: (state: T) => string): this;
  compile(options?: { checkpointer?: Checkpointer }): CompiledGraph<T>;
}

// Usage:
const workflow = new StateGraph()
  .addNode("triage", triageAgent)
  .addNode("research", researchAgent)
  .addNode("code", codeAgent)
  .addNode("respond", respondAgent)
  .addEdge("__start__", "triage")
  .addConditionalEdges("triage", (state) =>
    state.task_type === "research" ? "research" : "code"
  )
  .addEdge("research", "respond")
  .addEdge("code", "respond")
  .addEdge("respond", "__end__");

const compiled = workflow.compile({ checkpointer: new SqliteCheckpointer() });
const result = await compiled.invoke({ messages: [...] });
```

**Estimated Complexity**: ~800 lines, 2-3 files. Core graph execution + SQLite checkpointer.

---

#### 4.2 Zod-Validated Tool System

**Why**: Mastra's `createTool()` with Zod schemas is the best developer experience in the TypeScript ecosystem. Current JSON Schema approach is verbose and loses type safety at the boundary.

**Design**:

```typescript
// src/tools/tool-builder.ts
import { z } from "zod";

interface ToolDefinition2<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  name: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: TOutput;
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<z.infer<TOutput>>;
  // Middleware hooks
  beforeExecute?: (input: z.infer<TInput>, ctx: ToolContext) => Promise<void>;
  afterExecute?: (output: z.infer<TOutput>, ctx: ToolContext) => Promise<void>;
  onError?: (error: Error, ctx: ToolContext) => Promise<void>;
}

// Usage:
const searchTool = createTool({
  name: "web-search",
  description: "Search the web",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().default(5),
  }),
  outputSchema: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
  })),
  execute: async ({ query, maxResults }, ctx) => {
    const results = await searchService.search(query, maxResults);
    return results;
  },
});
```

**Estimated Complexity**: ~300 lines. Backward-compatible with existing tool definitions.

---

#### 4.3 Agent Handoff Protocol

**Why**: OpenAI Agents SDK's handoff pattern is the simplest and most elegant multi-agent coordination mechanism. Agents declare which agents they can delegate to, and the runtime handles routing. This is more practical than full graph workflows for 80% of multi-agent use cases.

**Design**:

```typescript
// src/agents/handoff.ts
interface AgentHandoff {
  targetAgentId: string;
  description: string;  // When to hand off (LLM uses this to decide)
  filterMessages?: (messages: Message[]) => Message[];  // Context filtering
  onHandoff?: (from: string, to: string, context: HandoffContext) => Promise<void>;
}

// In agent config:
const triageAgent: AgentConfig = {
  id: "triage",
  name: "Triage Agent",
  systemPrompt: "You route requests to the right specialist.",
  handoffs: [
    { targetAgentId: "research", description: "For research and analysis tasks" },
    { targetAgentId: "code", description: "For coding and technical tasks" },
    { targetAgentId: "support", description: "For customer support issues" },
  ],
};

// Handoff is surfaced to the LLM as a tool:
// The runtime adds a `handoff_to_<agent>` tool for each declared handoff.
// When the LLM calls it, the runtime transfers the conversation.
```

**Estimated Complexity**: ~400 lines. Integrates with existing runtime and tool system.

---

### P1 — Important (Ship in Next Iteration)

#### 4.4 Checkpointing and State Persistence

**Why**: LangGraph's checkpointing enables pause/resume, time-travel debugging, and crash recovery. This is essential for production workloads where agent runs can be long and expensive.

**Design**:

```typescript
// src/workflow/checkpointer.ts
interface Checkpoint {
  id: string;
  graphId: string;
  nodeId: string;
  state: Record<string, any>;
  createdAt: number;
  parentId: string | null;
  metadata: Record<string, any>;
}

interface Checkpointer {
  save(checkpoint: Checkpoint): Promise<void>;
  load(id: string): Promise<Checkpoint | null>;
  list(graphId: string, options?: { limit?: number }): Promise<Checkpoint[]>;
  getLatest(graphId: string): Promise<Checkpoint | null>;
}

class SqliteCheckpointer implements Checkpointer {
  // WAL mode for concurrent access
  // FTS for searching checkpoint metadata
}
```

**Estimated Complexity**: ~250 lines. SQLite-backed with WAL mode.

---

#### 4.5 Vector Memory with Semantic Search

**Why**: Every framework except Anorion supports vector-based memory retrieval. Flat key-value with FTS5 text search is insufficient for semantic understanding. The agent needs to retrieve relevant memories by meaning, not just keywords.

**Design**:

```typescript
// src/memory/vector-store.ts
interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  embedding: number[];
  metadata: {
    category: "identity" | "preference" | "fact" | "lesson" | "context";
    source: string;
    timestamp: number;
  };
}

interface VectorMemoryStore {
  store(entry: Omit<MemoryEntry, "id" | "embedding">): Promise<string>;
  search(query: string, options?: {
    agentId?: string;
    category?: string;
    topK?: number;
    threshold?: number;
  }): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
}

// Implementation: Bun:sqlite with a simple cosine similarity,
// or delegate to an external vector DB via plugin.
// For self-hosted: use sqlite-vss extension.
```

**Estimated Complexity**: ~500 lines for SQLite-vss implementation. ~200 lines for the abstraction.

---

#### 4.6 Guardrails Layer

**Why**: OpenAI Agents SDK's guardrails pattern provides a composable validation layer for input/output. This is essential for production safety — content filtering, PII detection, topic restrictions, and custom business logic.

**Design**:

```typescript
// src/agents/guardrails.ts
interface GuardrailResult {
  passed: boolean;
  message?: string;
  metadata?: Record<string, any>;
}

type GuardrailFn = (content: string, ctx: AgentContext) => Promise<GuardrailResult>;

interface GuardrailConfig {
  input?: GuardrailFn[];   // Run on user messages before agent processing
  output?: GuardrailFn[];  // Run on agent responses before returning
}

// Built-in guardrails:
const piiGuardrail: GuardrailFn = async (content) => {
  const piiDetected = detectPII(content);
  return {
    passed: !piiDetected,
    message: piiDetected ? "PII detected in message" : undefined,
  };
};

const topicGuardrail = (allowedTopics: string[]): GuardrailFn => async (content, ctx) => {
  // Use lightweight classifier to check topic
  return { passed: true };
};

// Usage in agent config:
const agent: AgentConfig = {
  id: "support",
  guardrails: {
    input: [piiGuardrail, topicGuardrail(["billing", "technical", "general"])],
    output: [contentPolicyGuardrail],
  },
};
```

**Estimated Complexity**: ~300 lines. Core framework + 3-4 built-in guardrails.

---

#### 4.7 Built-In Tracing / Observability

**Why**: OpenAI Agents SDK makes tracing built-in by default. Every agent invocation, tool call, handoff, and guardrail check is captured as spans. This is essential for debugging production issues.

**Design**:

```typescript
// src/shared/tracing.ts
interface TraceSpan {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;        // "agent.turn", "tool.execute", "handoff", "guardrail"
  startTime: number;
  endTime?: number;
  attributes: Record<string, any>;
  status: "ok" | "error" | "timeout";
}

interface Tracer {
  startSpan(name: string, attributes?: Record<string, any>): TraceSpan;
  endSpan(span: TraceSpan): void;
  getCurrentTrace(): TraceSpan[];
  export(): TraceExport;  // OTLP, JSON, custom
}

// Usage (automatic via runtime):
// The agent runtime automatically wraps each turn, tool call, and handoff in spans.
// No manual instrumentation needed.
```

**Estimated Complexity**: ~400 lines. Core tracer + OTLP exporter + SQLite persistence.

---

### P2 — Nice to Have (Future Iterations)

#### 4.8 Human-in-the-Loop Pattern

**Why**: LangGraph's interrupt pattern enables approval workflows where the agent pauses execution and waits for human input before continuing. Critical for high-stakes agent actions (e.g., executing shell commands, making API calls, spending money).

**Design**: Extend the graph engine with `interruptBefore` / `interruptAfter` compilation options. When interrupted, save checkpoint and return a "waiting for approval" status. Expose a REST endpoint for humans to approve/reject/edit and resume.

**Estimated Complexity**: ~350 lines (extends graph engine).

---

#### 4.9 Evaluator Pattern (Post-Processing Hooks)

**Why**: Eliza's Evaluator pattern runs post-processing after every agent turn — extracting facts, updating memory, logging decisions. This enables the agent to learn from its interactions automatically.

**Design**:

```typescript
interface Evaluator {
  name: string;
  description: string;
  handler: (runtime: AgentRuntime, result: AgentResult) => Promise<void>;
  validate: (runtime: AgentRuntime, result: AgentResult) => Promise<boolean>;
}

// Built-in evaluators:
const factExtractor: Evaluator = {
  name: "fact-extraction",
  handler: async (runtime, result) => {
    const facts = await extractFacts(result.content);
    for (const fact of facts) {
      await runtime.memory.save(fact);
    }
  },
  validate: async (runtime, result) => result.content.length > 50,
};
```

**Estimated Complexity**: ~200 lines for the framework + ~300 lines for built-in evaluators.

---

#### 4.10 Pre-Compaction Memory Flush (from OpenClaw/AutoGPT)

**Why**: OpenClaw and AutoGPT both flush important context to durable memory *before* compaction truncates the conversation. Without this, Anorion's `compactMessages()` silently discards information that the agent may need later. This is a critical data-loss gap.

**Design**:

```typescript
// src/memory/pre-compaction-flush.ts
async function preCompactionFlush(
  agentId: string,
  messages: Message[],
  memoryStore: MemoryStore,
): Promise<void> {
  // Identify messages that would be dropped by compaction
  const { wouldDrop } = compactMessages(messages, { dryRun: true });

  if (wouldDrop.length === 0) return;

  // Ask the LLM to extract important facts from messages about to be dropped
  const summary = await generateText({
    model: fastModel, // Use a cheap model for this
    system: "Extract key facts, decisions, and context from these messages. Be concise.",
    messages: [
      { role: "user", content: JSON.stringify(wouldDrop) },
    ],
  });

  // Save extracted memories
  await memoryStore.save(agentId, {
    key: `pre-compaction-${Date.now()}`,
    value: summary.text,
    category: "context",
    source: "auto-flush",
  });
}

// Integration in runtime.ts, before compactMessages():
if (shouldCompact(history)) {
  await preCompactionFlush(agent.id, history, memoryManager);
  const { messages: compacted } = compactMessages(history);
  contextMessages = compacted;
}
```

**Estimated Complexity**: ~150 lines.

---

#### 4.11 Prompt Caching Strategy

**Why**: Hermes's hybrid memory access pattern — baking stable context into cached system prompts and attaching dynamic context as turn-specific additions — significantly reduces token costs with providers that support prompt caching (Anthropic, OpenAI).

**Design**: Split system prompt into:
1. **Stable prefix**: Agent instructions, personality, capabilities (cached)
2. **Dynamic section**: Memory, current context, session state (ephemeral)

Use Anthropic's `cache_control` markers and OpenAI's cached system messages.

**Estimated Complexity**: ~200 lines.

---

#### 4.11 Structured Output with Error Strategies (from Mastra)

**Why**: Mastra's structured output system with Zod schemas and configurable error strategies gives agents typed return values. Anorion currently has no structured output support — all responses are raw strings.

**Design**:

```typescript
// src/agents/structured-output.ts
import { z } from "zod";

type ErrorStrategy = "strict" | "warn" | "fallback";

interface StructuredOutputConfig<T extends z.ZodType> {
  schema: T;
  errorStrategy?: ErrorStrategy;
  fallbackValue?: z.infer<T>;
  structuringModel?: string;  // Use a separate model for structuring
  jsonPromptInjection?: boolean;  // Fallback for models without response_format
}

// Usage in sendMessage:
const result = await sendMessage({
  agentId: "research",
  text: "Analyze these stocks",
  structuredOutput: {
    schema: z.array(z.object({
      ticker: z.string(),
      rating: z.enum(["buy", "hold", "sell"]),
      confidence: z.number().min(0).max(1),
    })),
    errorStrategy: "warn",
  },
});
// result.structured is typed as Array<{ ticker: string; rating: "buy"|"hold"|"sell"; confidence: number }>
```

**Estimated Complexity**: ~350 lines.

---

#### 4.12 ModelRetry Self-Correction (from Pydantic AI)

**Why**: Pydantic AI's `ModelRetry` pattern lets tools signal the LLM to retry with corrected parameters without counting as a failure. This is more elegant than error-based retry because the LLM gets explicit guidance.

**Design**:

```typescript
// src/tools/model-retry.ts
class ModelRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRetry";
  }
}

// In tool execution:
const searchTool = createTool({
  name: "user-lookup",
  execute: async ({ userId }, ctx) => {
    const user = await db.getUser(userId);
    if (!user) {
      throw new ModelRetry(`User ${userId} not found. Try searching by email instead.`);
    }
    return user;
  },
});

// Runtime intercepts ModelRetry, feeds message back to LLM without incrementing failure count
```

**Estimated Complexity**: ~100 lines. Minimal — just a special error class and runtime interception.

---

#### 4.13 Self-Improvement Loop

**Why**: Hermes agents create and improve skills from experience. After complex tool sequences, the agent is nudged to save what it learned. This creates a feedback loop that improves agent performance over time.

**Design**: After each agent turn, check if the turn involved complex tool usage. If so, inject a nudge into the next turn's context: "Consider saving a memory or creating a skill from what you just learned."

**Estimated Complexity**: ~150 lines.

---

#### 4.12 Session Queue Serialization (from OpenClaw)

**Why**: OpenClaw's session lane model serializes agent runs per session key, with three queue modes — `steer` (interrupt current run), `followup` (queue behind), `collect` (coalesce pending messages). This prevents concurrent state corruption and gives users control over queuing behavior.

**Design**:

```typescript
// src/agents/session-queue.ts
type QueueMode = "steer" | "followup" | "collect";

class SessionLane {
  private queue: PendingRun[] = [];
  private active: AbortController | null = null;

  async enqueue(input: SendMessageInput, mode: QueueMode): Promise<RunResult> {
    if (mode === "steer" && this.active) {
      this.active.abort(); // Cancel current run
    }
    // ... queue management
  }
}
```

**Estimated Complexity**: ~200 lines.

---

#### 4.13 Plugin Hook System (from OpenClaw)

**Why**: OpenClaw's plugin hook system (`before_tool_call`/`after_tool_call`, `before_agent_start`/`agent_end`, `message_received`/`message_sent`) enables cross-cutting concerns (auditing, rate limiting, content filtering) without modifying core code. This is more flexible than Anorion's current event bus approach for synchronous interception.

**Design**:

```typescript
// src/plugins/hooks.ts
interface PluginHooks {
  beforeAgentStart?: (ctx: AgentContext) => Promise<void>;
  afterAgentEnd?: (ctx: AgentContext, result: AgentResult) => Promise<void>;
  beforeToolCall?: (toolName: string, params: any, ctx: ToolContext) => Promise<void>;
  afterToolCall?: (toolName: string, result: ToolResult, ctx: ToolContext) => Promise<void>;
  messageReceived?: (envelope: MessageEnvelope) => Promise<MessageEnvelope | null>;
  messageSending?: (response: string, envelope: MessageEnvelope) => Promise<string>;
}

// Plugins register hooks that the runtime calls at each lifecycle point.
```

**Estimated Complexity**: ~250 lines.

---

#### 4.14 Block Streaming with Smart Chunking (from OpenClaw)

**Why**: OpenClaw's block streaming algorithm breaks agent responses at natural boundaries (paragraph → newline → sentence → whitespace) and never splits inside code fences. This produces much better streaming UX than raw token-level streaming, especially for long responses in messaging channels.

**Design**:

```typescript
// src/channels/block-chunker.ts
interface BlockChunkerOptions {
  minChars: number;   // Don't emit until buffer >= this
  maxChars: number;   // Prefer splits before this
  idleMs: number;     // Coalesce idle time
}

class BlockChunker {
  // Split at: paragraph → newline → sentence → whitespace
  // Never split inside code fences (close/reopen if forced)
  // Coalesce rapid short chunks via idle timer
}
```

**Estimated Complexity**: ~300 lines.

---

#### 4.15 Workflow Visual DSL

**Why**: Dify's visual builder makes workflow creation accessible to non-developers. Even for developers, a visual representation of multi-step agent workflows is valuable for debugging and communication.

**Design**: Define a JSON schema for graph definitions that can be rendered visually. Expose via the existing Web UI.

**Estimated Complexity**: ~1000+ lines (significant UI work).

---

## Priority Matrix

| # | Recommendation | Priority | Complexity | Impact | Effort |
|---|---------------|----------|-----------|--------|--------|
| 4.1 | Graph Workflow Engine | **P0** | ~800 LOC | High | 2-3 days |
| 4.2 | Zod-Validated Tools | **P0** | ~300 LOC | High | 1 day |
| 4.3 | Agent Handoff Protocol | **P0** | ~400 LOC | High | 1-2 days |
| 4.4 | Checkpointing | **P1** | ~250 LOC | Medium | 1 day |
| 4.5 | Vector Memory | **P1** | ~700 LOC | High | 2-3 days |
| 4.6 | Guardrails | **P1** | ~300 LOC | Medium | 1 day |
| 4.7 | Tracing/Observability | **P1** | ~400 LOC | High | 1-2 days |
| 4.8 | Human-in-the-Loop | **P2** | ~350 LOC | Medium | 1 day |
| 4.9 | Evaluator Pattern | **P2** | ~500 LOC | Medium | 1-2 days |
| 4.10 | Pre-Compaction Memory Flush | **P0** | ~150 LOC | High | 0.5 day |
| 4.11 | Prompt Caching | **P2** | ~200 LOC | Medium | 0.5 day |
| 4.12 | Self-Improvement | **P2** | ~150 LOC | Low | 0.5 day |
| 4.12 | Structured Output + Error Strategies | **P1** | ~350 LOC | High | 1-2 days |
| 4.13 | ModelRetry Self-Correction | **P1** | ~100 LOC | Medium | 0.5 day |
| 4.14 | Session Queue Serialization | **P1** | ~200 LOC | Medium | 0.5 day |
| 4.15 | Plugin Hook System | **P1** | ~250 LOC | High | 1 day |
| 4.16 | Block Streaming/Chunking | **P2** | ~300 LOC | Medium | 1 day |
| 4.17 | Visual DSL | **P2** | ~1000+ LOC | Medium | 5+ days |

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- **4.2** Zod-Validated Tools (backward-compatible, immediate DX improvement)
- **4.3** Agent Handoff Protocol (enables multi-agent use cases)
- **4.10** Pre-Compaction Memory Flush (prevents data loss — critical gap)
- **4.7** Tracing/Observability (needed before everything else for debugging)
- **4.13** ModelRetry Self-Correction (~100 LOC, huge DX win)
- **4.14** Session Queue Serialization (prevents concurrent state corruption)

### Phase 2: Workflow Engine (Week 3-4)
- **4.1** Graph-Based Workflow Engine
- **4.4** Checkpointing (builds on graph engine)
- **4.15** Plugin Hook System (enables cross-cutting concerns)
- **4.12** Structured Output + Error Strategies

### Phase 3: Intelligence (Week 5-6)
- **4.5** Vector Memory with Semantic Search
- **4.6** Guardrails Layer

### Phase 4: Polish (Week 7+)
- **4.8** Human-in-the-Loop
- **4.9** Evaluator Pattern
- **4.10** Prompt Caching
- **4.11** Self-Improvement Loop
- **4.16** Block Streaming with Smart Chunking
- **4.17** Visual DSL (optional, longer term)

---

## Key Takeaways

1. **Graph-based workflows are table stakes** — every major framework has them. Anorion's linear pipelines need to evolve.

2. **Handoffs are the simplest multi-agent pattern** — adopt OpenAI SDK's approach for 80% of use cases, graph engine for the remaining 20%.

3. **Vector memory is non-negotiable** — flat key-value memory is the biggest gap. Semantic retrieval is fundamental to agent intelligence.

4. **Type safety matters** — Zod validation on tools, typed state on graphs, typed outputs on agents. TypeScript developers expect this.

5. **Observability must be built-in** — tracing, spans, and guardrails shouldn't be afterthoughts. They're essential for production reliability.

6. **The evaluator pattern enables learning** — post-processing hooks that extract facts and update memory create a self-improving agent loop.

7. **Checkpointing enables reliability** — for long-running workflows, the ability to pause, resume, and time-travel is essential.
