# Agent Framework Architectural Analysis

Comprehensive research into LangGraph, Semantic Kernel, AutoGPT, CrewAI, Mastra, PydanticAI, Eliza, and Dify -- extracting code patterns and architectural decisions useful for building a TypeScript agent framework.

---

## 1. LangGraph (LangChain)

**Repo**: github.com/langchain-ai/langgraphjs (TypeScript)
**Docs**: docs.langchain.com/oss/javascript/langgraph/overview
**Paradigm**: Graph-based state machine for agent orchestration
**Philosophy**: "Low-level orchestration framework focused entirely on agent orchestration" -- does not abstract away complexity, gives full control.

### 1.1 State Machine Design

LangGraph models agent workflows as **directed graphs** with explicit state. The core abstraction is `StateGraph`, which defines:

- **State**: A typed schema (using `StateSchema`) that flows through the graph
- **Nodes**: Functions that take current state and return state updates
- **Edges**: Connections between nodes, including conditional routing
- **Compilation**: Graphs must be `.compile()`'d before execution

```typescript
// Core API from LangGraph.js
import { StateSchema, MessagesValue, GraphNode, StateGraph, START, END } from "@langchain/langgraph";

const State = new StateSchema({
  messages: MessagesValue,
});

// Node functions receive state, return partial state updates
const mockLlm: GraphNode<typeof State> = (state) => {
  return { messages: [{ role: "ai", content: "hello world" }] };
};

const graph = new StateGraph(State)
  .addNode("mock_llm", mockLlm)
  .addEdge(START, "mock_llm")
  .addEdge("mock_llm", END)
  .compile();

await graph.invoke({ messages: [{ role: "user", content: "hi!" }] });
```

**Key Architectural Decision**: State is **immutable** between nodes. Each node returns a *partial update* that gets merged into the state via reducer functions. The `MessagesValue` type uses an append reducer (new messages are appended to the list).

### 1.2 Graph-Based Workflow Patterns

**Conditional Routing**: Edges can be conditional, routing to different nodes based on current state:

```typescript
// Conditional edge pattern (Python API shown, same concept in JS)
graph.addConditionalEdges("agent", shouldContinue, {
  continue: "tools",
  end: END,
});
```

**Cyclic Graphs**: Unlike DAGs, LangGraph explicitly supports cycles, enabling agent loops (agent -> tools -> agent -> tools -> ... until done).

**Named Entry/Exit Points**: `START` and `END` are special nodes that mark graph boundaries.

**Inspiration**: Architecture inspired by Pregel (Google's graph processing framework) and Apache Beam (batch/streaming). The public API is inspired by NetworkX (Python graph library).

### 1.3 Checkpointing / State Persistence

LangGraph's checkpointing system provides **durable state persistence** at every node execution:

| Backend | Use Case |
|---------|----------|
| `MemorySaver` | In-memory, dev/testing |
| `SqliteSaver` | Local persistent storage |
| `PostgresSaver` | Production (concurrent access) |

**Architecture**:
- Every node execution triggers a checkpoint save
- Checkpoints store: current node position, channel values (state), pending writes, metadata
- Identified by `thread_id` (conversation) + `checkpoint_id` (state version)
- Enables: fault tolerance, time-travel debugging, conversation resumption

```typescript
const checkpointer = new MemorySaver();
const graph = builder.compile({ checkpointer });

const config = { configurable: { thread_id: "thread-1" } };
const result = await graph.invoke(input, config);
```

### 1.4 Human-in-the-Loop Patterns

Three mechanisms for HITL:

**1. `interrupt_before` / `interrupt_after`** -- Pause before/after specific nodes:
```typescript
const app = graph.compile({
  checkpointer: memoryCheckpointer,
  interruptBefore: ["human_review_node"]
});
```

**2. `NodeInterrupt`** -- Dynamic interrupt from within a node:
```typescript
function reviewNode(state) {
  if (state.requires_approval) {
    throw new NodeInterrupt("Awaiting human approval");
  }
  return state;
}
```

**3. State Update + Resume** -- Human modifies state, then execution resumes:
```typescript
// Human updates state
await app.updateState(config, { approved: true }, "human_review_node");
// Resume execution
const result = await app.invoke(null, config);
```

**Common patterns**: Approval gates (pause before critical actions), review & edit (pause after LLM generation), tool call confirmation, multi-turn chat.

### 1.5 Streaming Architecture

Three streaming modes:

| Mode | What it streams |
|------|----------------|
| `"values"` | Full state after each node |
| `"updates"` | Only the delta (node output) |
| `"messages"` | Token-by-token LLM output |

```typescript
// Streaming updates
const stream = await graph.stream(inputs, { streamMode: "updates" });
for await (const chunk of stream) {
  console.log(chunk);
}
```

### 1.6 Error Handling / Recovery

- Checkpointing provides fault tolerance -- resume from last checkpoint on failure
- Time-travel debugging -- replay or fork from any previous state
- Graph compilation catches structural errors before execution

### 1.7 Tool Call Integration

Higher-level `createReactAgent` API handles the tool loop automatically:

```typescript
import { createReactAgent, tool } from "langchain";
import { z } from "zod";

const search = tool(
  async ({ query }) => {
    return "It's 60 degrees and foggy.";
  },
  {
    name: "search",
    description: "Call to surf the web.",
    schema: z.object({ query: z.string() }),
  }
);

const agent = createReactAgent({ llm: model, tools: [search] });
const result = await agent.invoke({
  messages: [{ role: "user", content: "what is the weather in sf" }]
});
```

### 1.8 TypeScript-Specific Patterns for Our Framework

- **StateSchema + typed GraphNode**: Type-safe state definitions with reducer semantics
- **Immutable state updates**: Nodes return partial updates, not full state
- **`.compile()` pattern**: Separates graph definition from execution, enables validation
- **`START`/`END` sentinel constants**: Clean entry/exit point declaration
- **Tool definitions with Zod schemas**: Runtime + compile-time type safety

---

## 2. Semantic Kernel (Microsoft)

**Repo**: github.com/microsoft/semantic-kernel
**Docs**: learn.microsoft.com/semantic-kernel
**Languages**: C#, Python, Java (**NO TypeScript/JS SDK**)
**Paradigm**: Plugin-based AI middleware with automatic function calling
**Philosophy**: "Lightweight, open-source development kit that lets you easily bring AI into your apps"

### 2.1 Agent Orchestration Approach

The **Kernel** is the central orchestrator -- a dependency injection container that holds:

- **AI Services**: LLM connections (OpenAI, Azure, HuggingFace, Ollama)
- **Plugins**: Groups of functions the AI can call
- **Memory**: Vector stores and conversation history
- **Filters/Hooks**: Cross-cutting concerns (telemetry, logging)

```python
# Basic agent pattern
agent = ChatCompletionAgent(
    service=AzureChatCompletion(),
    name="SK-Assistant",
    instructions="You are a helpful assistant.",
)
response = await agent.get_response(messages="Write a haiku about Semantic Kernel.")
```

**Multi-agent orchestration** uses agents-as-plugins:

```python
billing_agent = ChatCompletionAgent(service=AzureChatCompletion(), name="BillingAgent", instructions="...")
refund_agent = ChatCompletionAgent(service=AzureChatCompletion(), name="RefundAgent", instructions="...")
triage_agent = ChatCompletionAgent(
    service=OpenAIChatCompletion(),
    name="TriageAgent",
    instructions="Evaluate user requests and forward them...",
    plugins=[billing_agent, refund_agent],  # Agents as plugins!
)
```

### 2.2 Plugin System Design

Plugins are the core extensibility mechanism:

```python
class MenuPlugin:
    @kernel_function(description="Provides a list of specials from the menu.")
    def get_specials(self) -> Annotated[str, "Returns the specials from the menu."]:
        return """Special Soup: Clam Chowder\nSpecial Salad: Cobb Salad"""

    @kernel_function(description="Provides the price of the requested menu item.")
    def get_item_price(
        self, menu_item: Annotated[str, "The name of the menu item."]
    ) -> Annotated[str, "Returns the price of the menu item."]:
        return "$9.99"
```

**Plugin anatomy**:
- Groups of functions with semantic descriptions for AI understanding
- Three import types: **native code** (decorators), **OpenAPI specification**, **MCP Server**
- Functions use `@kernel_function` decorator with descriptions
- Parameters use `Annotated` types with descriptions

**AI-friendly plugin guidelines**:
- Descriptive function names
- Minimize parameters (fewer = easier for LLM to use correctly)
- Clear parameter names and descriptions
- **Local state pattern**: Store data locally, pass only state IDs to LLM (reduces context pollution)

**Agent with plugins**:
```python
agent = ChatCompletionAgent(
    service=AzureChatCompletion(),
    name="SK-Assistant",
    instructions="You are a helpful assistant.",
    plugins=[MenuPlugin()],
    arguments=KernelArguments(settings)
)
```

### 2.3 Planning Patterns

**Critical finding**: Handlebars Planner and Stepwise Planner are **DEPRECATED and REMOVED**.

The current planning approach uses **automatic function calling**:

1. Register plugins with the kernel
2. Enable `FunctionChoiceBehavior.Auto()`
3. Invoke chat completion with the kernel
4. The kernel handles the entire function calling loop automatically

```python
# Automatic planning (the modern way)
settings.execution_settings.function_choice_behavior = FunctionChoiceBehavior.Auto()
response = await chat_completion.get_chat_message_content(chat_history, settings, kernel=kernel)
```

The 7-step automatic function calling loop:
1. Send chat history + available functions to LLM
2. LLM decides which function to call (if any)
3. Kernel invokes the function
4. Function result appended to chat history
5. Repeat until LLM provides final response (no more function calls)
6. Supports parallel function calling (OpenAI 1106+)

### 2.4 Memory / Context Management

Two generations of memory abstractions:

**Original** (`ISemanticTextMemory` / `IMemoryStore`):
- Text chunks with embeddings for semantic search
- Being superseded

**Current** (`IVectorStore` abstraction):
- Unified interface over multiple vector DB backends (Azure AI Search, Qdrant, Pinecone, Redis, Chroma, Weaviate, in-memory)
- `IVectorStoreRecordCollection<TKey, TRecord>` for typed collections
- Record definitions with attributes: `[VectorStoreRecordKey]`, `[VectorStoreRecordData]`, `[VectorStoreRecordVector]`
- Handles embedding generation and storage

**Context management**:
- `KernelArguments` (formerly `ContextVariables`) -- variables passed between pipeline steps
- `ChatHistory` -- tracks conversational context
- Memory injected into prompts via `{{memory recall ...}}` syntax or custom plugins

### 2.5 Integration Patterns

- **OpenAPI spec import**: Import REST APIs as plugins directly (like Microsoft 365 Copilot does)
- **MCP Server support**: Connect to Model Context Protocol servers
- **Enterprise features**: Telemetry via OpenTelemetry, hooks and filters for cross-cutting concerns
- **Process Framework**: State machine abstraction for multi-step business processes (like LangGraph but at a higher level)

### 2.6 TypeScript-Relevant Patterns for Our Framework

- **Plugin-first architecture**: Tools are first-class citizens with AI-readable descriptions
- **Kernel as DI container**: Central registry for services, plugins, and memory
- **Automatic function calling loop**: Let the framework handle tool invocation cycling
- **Agents as plugins**: Elegant composition pattern for multi-agent systems
- **Annotated types with descriptions**: Type system that serves both runtime and LLM understanding
- **OpenAPI/MCP import**: Standard protocols for tool discovery

---

## 3. AutoGPT

**Repo**: github.com/Significant-Gravitas/AutoGPT
**Paradigm**: Autonomous agent with Plan-Act-Observe loop
**Language**: Python (primarily)

### 3.1 Agentic Loop Design

AutoGPT's core loop: **Plan -> Execute -> Observe -> Reflect**:

1. **Think**: LLM generates thoughts about the current state
2. **Plan**: Determine next action(s)
3. **Act**: Execute the chosen action (tool call)
4. **Observe**: Process the result
5. **Reflect**: Evaluate progress toward the goal

### 3.2 Planning and Task Decomposition

- Goal decomposed into tasks stored in a task queue
- Each iteration: LLM selects next task, executes it, evaluates result
- Self-correction: If a task fails, the agent can revise its approach
- The agent maintains a "thought chain" across iterations

### 3.3 Memory Architecture

- **Short-term**: Conversation history maintained in prompt context
- **Long-term**: Vector store (Pinecone, Weaviate, ChromaDB, etc.) for persistent memories
- Memory is stored as embeddings and retrieved via similarity search
- Agent decides what to memorize and what to recall

### 3.4 Key Architectural Patterns

- **Command system**: Tools are "commands" the agent can execute (web search, file I/O, code execution)
- **Workspace isolation**: Agent operates within a bounded workspace
- **Budget/cost tracking**: Token usage and cost monitoring
- **Event-driven**: Modern AutoGPT uses an event system for extensibility

### 3.5 TypeScript-Relevant Patterns

- **Task queue model**: Structured task decomposition for goal-oriented agents
- **Self-correction loops**: Agent evaluates its own outputs and retries
- **Memory hierarchy**: Short-term (context window) + long-term (vector store)
- **Workspace abstraction**: Bounded execution environment for safety

---

## 4. CrewAI

**Repo**: github.com/crewAIInc/crewAI
**Paradigm**: Multi-agent orchestration with role-based agents
**Language**: Python

### 4.1 Multi-Agent Orchestration

CrewAI orchestrates multiple agents working together:

```python
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Senior Research Analyst",
    goal="Discover and analyze technology trends",
    backstory="You are a seasoned researcher...",
    tools=[search_tool, scrape_tool],
)

writer = Agent(
    role="Tech Content Strategist",
    goal="Create compelling content",
    backstory="You are a creative writer...",
)

research_task = Task(description="Research AI trends", agent=researcher)
write_task = Task(description="Write an article", agent=writer)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    process=Process.sequential,  # or hierarchical
)
result = crew.kickoff()
```

### 4.2 Role-Based Agent Design

Agents are defined by:
- **Role**: What the agent does
- **Goal**: What it's trying to achieve
- **Backstory**: Context/personality that shapes behavior
- **Tools**: What it can use
- **LLM**: Which model powers it (can differ per agent)

### 4.3 Sequential vs Parallel Workflows

- **Sequential**: Tasks execute one after another, outputs feed into next task
- **Hierarchical**: A "manager" agent delegates tasks to worker agents
- **Custom Flows**: CrewAI Flows system for more complex orchestration

### 4.4 Task Delegation and Communication

- Tasks have explicit input/output contracts
- Agent outputs automatically become available to downstream agents
- Context passing: Tasks can reference outputs from other tasks

### 4.5 Memory Sharing

- **Short-term**: In-conversation context
- **Long-term**: Persistent memory across executions
- **Entity memory**: Remember specific entities/facts
- Memory can be shared across agents in a crew

### 4.6 TypeScript-Relevant Patterns

- **Role-based agent configuration**: Declarative agent definitions with role/goal/backstory
- **Task objects**: First-class task abstraction with inputs/outputs
- **Crew orchestration**: Sequential and hierarchical multi-agent patterns
- **Flows system**: Composable workflow building blocks
- **Memory sharing**: Cross-agent memory with different scopes

---

## 5. Mastra (TypeScript Agent Framework)

**Repo**: github.com/mastrahq/mastra
**Paradigm**: TypeScript-native agent framework
**Language**: TypeScript (most relevant for our purposes)

### 5.1 Tool Definition Patterns

Mastra uses a clean TypeScript-native tool API:

```typescript
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const weatherTool = createTool({
  id: "getWeather",
  description: "Get weather for a location",
  inputSchema: z.object({
    location: z.string(),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    condition: z.string(),
  }),
  execute: async ({ context }) => {
    const result = await fetchWeather(context.location);
    return { temperature: result.temp, condition: result.condition };
  },
});
```

### 5.2 Workflow System Design

Mastra has a **step-based workflow engine**:

```typescript
import { Workflow, Step } from "@mastra/core/workflows";

const step1 = new Step({
  id: "step1",
  execute: async ({ context }) => {
    return { result: "step1 output" };
  },
});

const workflow = new Workflow({
  name: "my-workflow",
  triggerSchema: z.object({ input: z.string() }),
})
  .step(step1)
  .then(step2)
  .branch([
    { condition: (ctx) => ctx.step1.result === "A", workflow: workflowA },
    { condition: (ctx) => ctx.step1.result === "B", workflow: workflowB },
  ]);
```

### 5.3 Agent Configuration

```typescript
import { Agent } from "@mastra/core/agent";

const agent = new Agent({
  name: "myAgent",
  instructions: "You are a helpful assistant",
  model: openai("gpt-4o"),
  tools: { weatherTool },
});
```

### 5.4 TypeScript-Specific Patterns

- **Zod-first schema definitions**: Input/output schemas for tools and workflows
- **Typed context flow**: Type-safe data passing between workflow steps
- **First-class TypeScript**: Built for TS from the ground up, not a port
- **Structured output**: Native support for typed agent responses
- **Bun compatibility**: Works with Bun runtime

---

## 6. PydanticAI / OpenAI Agents SDK

### 6.1 PydanticAI

**Repo**: github.com/pydantic/pydantic-ai
**Paradigm**: Type-safe agent framework using Pydantic for validation
**Language**: Python

**Key pattern -- Typed agents with dependency injection**:

```python
from pydantic_ai import Agent
from pydantic import BaseModel

class CityLocation(BaseModel):
    city: str
    country: str

agent = Agent(
    "openai:gpt-4o",
    result_type=CityLocation,  # Structured output type
)

@agent.system_prompt
async def add_city_context(ctx) -> str:
    return f"User is asking about {ctx.deps.city}"

result = await agent.run("Where is the Eiffel Tower?")
print(result.data)  # CityLocation(city="Paris", country="France")
```

**Dependency injection**:
```python
agent = Agent("openai:gpt-4o", deps_type=MyDeps)

async def my_tool(ctx: RunContext[MyDeps], query: str) -> str:
    # ctx.deps is typed as MyDeps
    return ctx.deps.db.query(query)
```

### 6.2 OpenAI Agents SDK

**Key patterns**:

- **Guardrails**: Input/output validation that runs before/after agent execution
- **Tracing**: Built-in distributed tracing for agent execution
- **Handoffs**: Agents can hand off conversations to other agents

```python
from agents import Agent, Runner, handoff

billing_agent = Agent(name="Billing", instructions="...")
refund_agent = Agent(name="Refund", instructions="...")

triage_agent = Agent(
    name="Triage",
    instructions="Route to billing or refund",
    handoffs=[handoff(billing_agent), handoff(refund_agent)],
)
```

### 6.3 TypeScript-Relevant Patterns

- **Result type validation**: Agent outputs validated against a schema
- **Dependency injection via context**: Tools receive typed dependencies
- **Guardrails pattern**: Input/output validation as composable middleware
- **Handoff primitives**: First-class multi-agent handoff support
- **Structured output**: Type-safe agent responses

---

## 7. Eliza (elizaOS)

**Repo**: github.com/elizaOS/eliza
**Paradigm**: Multi-platform autonomous agent framework
**Language**: TypeScript
**Focus**: Crypto/social media agents

### 7.1 Multi-Channel Architecture

Eliza supports running a single agent persona across multiple platforms simultaneously:

- Discord, Telegram, Twitter/X, and more via adapters
- Each channel is an adapter implementing a common interface
- Messages from all channels flow into a unified processing pipeline

### 7.2 Character/Persona System

```typescript
// Character definition
const character = {
  name: "Agent",
  bio: ["A helpful AI assistant..."],
  lore: ["Background story elements..."],
  messageExamples: [...],
  postExamples: [...],
  topics: [...],
  style: { all: ["concise", "friendly"], chat: ["casual"] },
  adjectives: ["smart", "witty"],
  plugins: [...],
};
```

Characters are rich persona definitions that shape agent behavior across all channels.

### 7.3 Memory Management

- **RAG-based memory**: Vector store for long-term memory retrieval
- **Conversation memory**: Per-channel conversation history
- **Entity memory**: Remember specific users/entities across interactions
- Memory is partitioned by room (channel) and user

### 7.4 Plugin System

Plugins extend agent capabilities:
- **Actions**: Things the agent can do (send message, trade, etc.)
- **Evaluators**: Assess messages and decide on actions
- **Providers**: Supply context/data to the agent

### 7.5 Runtime Architecture

```
Message Input -> Evaluator -> (decides action) -> Action Execution -> Response
                          -> Memory Store/Retrieve
```

The runtime uses an **action/evaluator pattern**: evaluators analyze incoming messages and decide which actions to take.

### 7.6 TypeScript-Relevant Patterns

- **Character-driven persona**: Declarative persona system that shapes agent behavior
- **Multi-channel adapters**: Common interface for multiple messaging platforms
- **Action/Evaluator pattern**: Separation of "what to do" from "when to do it"
- **Room-scoped memory**: Memory partitioned by conversation context
- **Plugin as capabilities**: Extend agents through plugins with actions, evaluators, providers

---

## 8. Dify (Visual Agent Builder)

**Repo**: github.com/langgenius/dify
**Paradigm**: Visual workflow builder for AI applications
**Language**: Python (backend) + Next.js (frontend)

### 8.1 Visual Workflow/Agent Builder

Dify provides a visual DSL for constructing agent workflows:
- Drag-and-drop node-based editor
- Each node represents an action (LLM call, tool use, condition, etc.)
- Connections define data flow between nodes

### 8.2 DSL for Agent Workflows

The visual editor generates a structured DSL (JSON/YAML) that defines:
- Node types and configurations
- Edge connections and data flow
- Variable bindings between nodes
- Error handling strategies per node

### 8.3 Node-Based Workflow Execution

Node types include:
- **LLM Node**: Call an LLM with a prompt template
- **Tool Node**: Execute a tool/API
- **Condition Node**: Branching logic (if/else, switch)
- **Variable Aggregator**: Merge data from parallel branches
- **Iteration Node**: Loop over a list of items
- **Code Node**: Execute custom Python/JavaScript

### 8.4 Variable Passing Between Nodes

Variables flow through connections with explicit typing:
- Output from one node maps to input of the next
- Variable references use dot notation: `{{node_name.output.field}}`
- Type checking at connection time

### 8.5 Session Management

- Conversations are first-class entities
- Each workflow execution is tied to a conversation/session
- Variables can be session-scoped (persisted) or execution-scoped (ephemeral)

### 8.6 TypeScript-Relevant Patterns

- **Visual DSL -> runtime**: Separation of workflow definition from execution
- **Typed variable passing**: Explicit data contracts between nodes
- **Node type registry**: Extensible set of node types
- **Variable scope**: Session vs execution scoping for state
- **Iteration node**: First-class support for looping/map operations in workflows

---

## Cross-Framework Synthesis: Key Patterns for a TypeScript Agent Framework

### Architecture Patterns to Adopt

| Pattern | Source | Why It Matters |
|---------|--------|---------------|
| **Graph/State Machine** | LangGraph | Cyclic agent loops, conditional routing, durable execution |
| **Plugin System** | Semantic Kernel | Extensible tool registration with AI-readable descriptions |
| **Automatic Function Calling Loop** | Semantic Kernel | Framework handles tool invocation cycling automatically |
| **Checkpointing** | LangGraph | Fault tolerance, time-travel debugging, HITL |
| **Zod-First Schemas** | Mastra | Type-safe tool I/O in TypeScript |
| **Role-Based Agents** | CrewAI | Declarative agent configuration with role/goal/backstory |
| **Agents-as-Plugins** | Semantic Kernel | Elegant multi-agent composition |
| **Dependency Injection** | PydanticAI | Typed context passed to tools |
| **Result Type Validation** | PydanticAI | Structured, validated agent outputs |
| **Character/Persona System** | Eliza | Rich persona definitions shaping agent behavior |
| **Multi-Channel Adapters** | Eliza | One agent across many platforms |
| **Guardrails** | OpenAI Agents SDK | Input/output validation as middleware |
| **Visual DSL** | Dify | Workflow definition separate from execution |

### TypeScript-Specific Recommendations

1. **Use Zod for all schemas** -- Tool inputs, outputs, agent state, workflow variables
2. **Generic typed state** -- `StateGraph<TState>` with reducer functions
3. **`.compile()` pattern** -- Validate graph structure before execution
4. **Async generators for streaming** -- `async function*` for token-by-token streaming
5. **Plugin registry with decorators** -- `@tool()` or `@plugin()` decorators for registration
6. **Result type generics** -- `Agent<TInput, TOutput, TDependencies>` for full type safety
7. **Adapter pattern for channels** -- Common interface for Telegram, Discord, API, CLI
8. **Checkpoint interface** -- `ICheckpointStore` with implementations for SQLite, Postgres, Redis

### State Management Patterns

```
┌─────────────────────────────────────────────────┐
│                  Graph State                     │
│  (typed, immutable between nodes,               │
│   updated via reducer functions)                 │
├─────────────────────────────────────────────────┤
│  messages: Message[]  (append reducer)           │
│  context: Record<string, any>  (replace reducer) │
│  artifacts: Artifact[]  (append reducer)         │
│  metadata: Metadata  (merge reducer)             │
└─────────────────────────────────────────────────┘
         │                    │
    ┌────▼────┐        ┌─────▼─────┐
    │ Check-  │        │  Memory   │
    │ pointer │        │  Store    │
    │ (dur-   │        │ (vector   │
    │  able)  │        │  search)  │
    └─────────┘        └───────────┘
```

### Tool Definition Pattern (Recommended)

```typescript
// Combining best patterns from Mastra + SK + LangGraph
interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;  // AI-readable
  inputSchema: ZodSchema<TInput>;
  outputSchema: ZodSchema<TOutput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

// Usage
const weatherTool: ToolDefinition<{ location: string }, { temp: number }> = {
  name: "get_weather",
  description: "Get current weather for a location",
  inputSchema: z.object({ location: z.string() }),
  outputSchema: z.object({ temp: z.number() }),
  execute: async ({ location }, ctx) => {
    return { temp: await fetchWeather(location) };
  },
};
```

### Agent Definition Pattern (Recommended)

```typescript
// Combining CrewAI roles + SK plugins + PydanticAI result types
interface AgentDefinition<TState, TResult> {
  name: string;
  role: string;           // From CrewAI
  goal: string;           // From CrewAI
  backstory: string;      // From CrewAI
  instructions: string;   // From SK
  tools: ToolDefinition[]; // From SK/LangGraph
  resultType?: ZodSchema<TResult>; // From PydanticAI
}
```

---

## Sources

- [LangGraph.js GitHub](https://github.com/langchain-ai/langgraphjs)
- [LangGraph Python GitHub](https://github.com/langchain-ai/langgraph)
- [LangGraph Overview Docs](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Semantic Kernel GitHub](https://github.com/microsoft/semantic-kernel)
- [Semantic Kernel Plugins](https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/)
- [Semantic Kernel Planning](https://learn.microsoft.com/en-us/semantic-kernel/concepts/planning/)
- [Semantic Kernel Overview](https://learn.microsoft.com/en-us/semantic-kernel/overview/)
- [AutoGPT GitHub](https://github.com/Significant-Gravitas/AutoGPT)
- [CrewAI GitHub](https://github.com/crewAIInc/crewAI)
- [Mastra GitHub](https://github.com/mastrahq/mastra)
- [PydanticAI GitHub](https://github.com/pydantic/pydantic-ai)
- [Eliza GitHub](https://github.com/elizaOS/eliza)
- [Dify GitHub](https://github.com/langgenius/dify)
