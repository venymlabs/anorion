# Anorion Framework — Production Readiness Audit

**Date:** 2026-04-05  
**Compared against:** OpenClaw (gateway runtime), Hermes (Python agent framework)

---

## Executive Summary

Anorion has a solid foundation — clean TypeScript, Vercel AI SDK integration, SQLite persistence, event bus, and basic agentic loop. However, it has critical gaps in five areas: **streaming UX, context compaction quality, Telegram channel polish, subagent orchestration, and session resilience**. These are the differences between a demo and a production system.

---

## 1. Agent Executor Weaknesses

### 1.1 Agentic Loop Quality

**Anorion:** Uses `generateText` with `stepCountIs(maxIter)` and `onStepFinish`. Tool calls are tracked but the loop is a single black-box call — no intermediate visibility, no per-step streaming to the user, no step-level error recovery.

**OpenClaw:** Serialized per-session queue, lifecycle events (`start`/`end`/`error`), tool events streamed to the user in real-time, per-step observability. The user sees tool calls as they happen.

**Hermes:** Step-by-step execution with context compression checks between steps, token tracking from actual API responses.

**Fixes needed:**
- Break the monolithic `generateText` into an explicit step loop where each step streams deltas + tool calls to the channel
- Emit per-step lifecycle events on the event bus
- Add per-step error handling (retry individual tool calls, don't fail the whole run)

### 1.2 Streaming Support

**Anorion:** `streamMessage` generator exists but is **never connected to any channel**. The Telegram channel calls `sendMessage` (non-streaming) exclusively. The `streamLlm` function doesn't handle tool execution in the stream — it yields `tool_call` events but nobody processes them.

**OpenClaw:** Full streaming — assistant deltas, tool events, and lifecycle events all stream to the user in real-time. The gateway bridges pi-agent-core stream events to channel adapters.

**Fixes needed:**
- Connect `streamMessage` to Telegram via chunked message editing (send placeholder, edit with deltas)
- Handle tool calls in the streaming path — the current `streamLlm` yields them but the `streamMessage` function ignores them
- Add streaming support to the channel adapter interface (`sendStream` method)

### 1.3 Context Management

**Anorion:** `compactMessages` does naive truncation — slices messages to 100 chars each and concatenates. No LLM summarization. Uses rough char/4 token estimation. `shouldCompact` only triggers at 80% of 128K tokens (static threshold, not model-aware).

**OpenClaw:** LLM-powered summarization using a dedicated model. Model-specific context windows. Auto-compaction with retry. Pre-compaction memory flush (silent agentic turn to write durable notes before context is lost). Session pruning for large tool results.

**Hermes:** `ContextCompressor` uses Gemini Flash for cheap/fast summarization. Protects head + tail turns. Tracks actual token counts from API responses (not estimates). Supports pre-flight checks before API calls.

**Fixes needed (critical):**
```typescript
// Replace naive truncation with LLM summarization
async function compactWithLlm(middle: Message[]): Promise<Message> {
  const summary = await callLlm({
    modelId: 'gemini-flash', // cheap/fast model
    systemPrompt: 'Summarize the conversation so far, preserving key decisions, facts, and action items.',
    messages: middle.map(m => ({ role: m.role, content: m.content })),
    maxTokens: 2000,
  });
  return { /* summary message */ };
}
```
- Make `maxContextTokens` model-aware (query the model's actual context window)
- Track actual token usage from API responses instead of char/4 estimation
- Add pre-compaction memory flush (write important context to disk before compaction)
- Add session pruning for large tool outputs (truncate in-memory, keep DB intact)

### 1.4 Tool Execution

**Anorion:** Serial execution only. The AI SDK handles tool calls internally within `generateText` — no parallel execution control, no per-tool retry, no tool-level streaming. Timeout and output truncation exist but are basic (30s default, 1MB max).

**OpenClaw:** Per-tool execution with abort signals, sandbox isolation, structured tool results, and tool-level streaming. Tools can be long-running with progress updates.

**Fixes needed:**
- Add explicit parallel tool execution when the model returns multiple tool calls in one step
- Add per-tool retry with configurable retry policy
- Add tool result streaming/progress updates to the channel
- Add tool-level metrics (latency, success rate) to the event bus

### 1.5 Subagent Architecture

**Anorion:** Basic but functional. Max depth 2, max 5 concurrent, global limit 200. Children can't spawn further children (spawn-agent tool is filtered out). Promise-based — parent blocks waiting for child result. No push-based completion notification.

**OpenClaw:** Push-based completion (subagents auto-announce results). Subagents can be monitored, steered, and killed. Multiple subagents run in parallel. Completion is event-driven, not polled.

**Fixes needed:**
- Add push-based completion (emit event when child finishes, parent subscribes)
- Add `steer` capability — parent can send additional instructions to running child
- Add `list` capability for parent to see all running children with status
- Consider allowing depth > 2 with diminishing tool access

### 1.6 Session Persistence and Recovery

**Anorion:** In-memory Map + SQLite backup. Lazy loading from DB exists (`getOrLoad`) but `get()` doesn't use it — returns `undefined` if not in memory. Eviction drops sessions from memory without guaranteeing DB state is current. No crash recovery — if the process dies mid-run, the session is in an inconsistent state.

**OpenClaw:** JSONL-based session history (append-only, crash-safe). Gateway is source of truth. Session write locks prevent corruption. Full recovery on restart.

**Fixes needed (critical):**
```typescript
// Fix get() to actually load from DB
get(id: string): Session | undefined {
  const cached = this.sessions.get(id);
  if (cached) return cached;
  // This is a sync method — make get() async or use getOrLoad everywhere
  return undefined; // BUG: silently loses sessions
}
```
- Make session access consistently async, always checking DB
- Add JSONL append-only log for crash recovery
- Add session write locks to prevent concurrent corruption
- Add run-level recovery (resume interrupted agent loops on restart)

### 1.7 Model Fallback Quality

**Anorion:** Primary model fails → try fallback. Two fallback models max. Circuit breaker exists (5 failures → open for 60s). Retry with exponential backoff + jitter. But: circuit breaker is per-model globally (not per-agent/per-session), no auth profile rotation, no session stickiness.

**OpenClaw:** Auth profile rotation within provider → model fallback chain → per-session pinning → cooldown tracking. Much more sophisticated.

**Fixes needed:**
- Per-session model pinning (don't rotate models mid-conversation unnecessarily)
- Per-agent circuit breaker (not global)
- Add health check / warm-up calls to detect model issues before user requests
- Log fallback events with enough detail to diagnose provider issues

### 1.8 Memory Integration

**Anorion:** `memoryManager.buildContext(agentId)` injects memory into system prompt. Basic key-value store with categories. No daily files, no workspace file system, no memory search, no automatic memory extraction.

**OpenClaw:** Markdown files in workspace (`memory/YYYY-MM-DD.md`, `MEMORY.md`). Memory search tools. Pre-compaction memory flush. Agent reads/writes its own memory files. Long-term + daily memory layers.

**Hermes:** Trajectory saving (JSONL). Context compression preserves key information.

**Fixes needed:**
- Add workspace-based memory (Markdown files, not just key-value store)
- Add memory search tool (semantic or keyword search over memory entries)
- Add automatic memory extraction after each agent turn
- Add pre-compaction memory flush

---

## 2. Telegram Channel Weaknesses

### 2.1 No Typing Indicators

**Current:** User sends message → waits in silence → gets response.

**Fix:**
```typescript
private async handleTextMessage(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat.id);
  
  // Send typing indicator
  await this.bot.api.sendChatAction(chatId, 'typing');
  
  // Re-send periodically during long operations
  const typingInterval = setInterval(() => {
    this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  
  try {
    // ... existing handler logic, pass envelope to handlers
    for (const handler of this.handlers) {
      await handler(envelope); // make handlers async
    }
  } finally {
    clearInterval(typingInterval);
  }
}
```

### 2.2 Markdown Parsing Issues

**Current:** Uses `parse_mode: 'Markdown'` which is Telegram's legacy Markdown v1. Breaks on:
- Nested formatting (`**bold _italic_**`)
- Unescaped special chars (`_`, `*`, `` ` ``, `[`)
- Lists and code blocks
- Any content from LLM that isn't carefully escaped

**Fix:**
```typescript
// Use MarkdownV2 or HTML (HTML is more reliable)
await this.bot.api.sendMessage(chatId, escapeMarkdownV2(chunk), {
  parse_mode: 'MarkdownV2',
  reply_to_message_id: replyToId,
});

function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
```
Better yet: use `parse_mode: 'HTML'` which is far more forgiving for LLM output.

### 2.3 No Streaming Support

**Current:** Waits for full response, then sends. User sees nothing for 5-30+ seconds.

**Fix:** Send a placeholder message, then edit it repeatedly as chunks arrive:
```typescript
async sendStream(envelope: MessageEnvelope, stream: AsyncIterable<string>): Promise<void> {
  const chatId = envelope.metadata?.chatId;
  
  // Send placeholder
  const msg = await this.bot.api.sendMessage(chatId, '⏳ Thinking...', {
    reply_to_message_id: envelope.metadata?.messageId,
  });
  
  let buffer = '';
  let lastEdit = 0;
  
  for await (const chunk of stream) {
    buffer += chunk;
    const now = Date.now();
    if (now - lastEdit > 800 && buffer.length > 0) { // Telegram rate limit: ~1 edit/sec
      try {
        await this.bot.api.editMessageText(chatId, msg.message_id, buffer.slice(0, 4096), {
          parse_mode: 'HTML',
        });
        lastEdit = now;
      } catch {}
    }
  }
  
  // Final edit with full text (chunked if needed)
  await this.editOrSendNew(chatId, msg.message_id, buffer);
}
```

### 2.4 No Media Handling

**Current:** Only handles `message:text`. Images, files, voice messages, stickers — all ignored.

**Fix:**
```typescript
// Add handlers for media
this.bot.on('message:photo', async (ctx) => {
  const photo = ctx.message.photo.pop(); // largest size
  const fileUrl = await ctx.api.getFile(photo.file_id);
  // Pass to agent as image input
});

this.bot.on('message:voice', async (ctx) => {
  // Download voice, transcribe, pass text to agent
});

this.bot.on('message:document', async (ctx) => {
  // Handle file uploads
});
```

### 2.5 No Inline Keyboard Support

**Current:** No interactive UI elements. User must type everything.

**Fix:** Add inline keyboard support for common actions:
```typescript
await this.bot.api.sendMessage(chatId, 'What would you like to do?', {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'action:status' },
        { text: '🗑️ Reset', callback_data: 'action:reset' },
      ],
    ],
  },
});

this.bot.on('callback_query', async (ctx) => {
  const action = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  // Route to appropriate handler
});
```

### 2.6 No Message Editing/Updates

**Current:** Each response is a new message. Can't update previous messages with new information.

**Fix:** Track sent message IDs per session, add `editMessage` method to channel adapter:
```typescript
async edit(chatId: string, messageId: number, newText: string): Promise<void> {
  await this.bot.api.editMessageText(chatId, messageId, newText, {
    parse_mode: 'HTML',
  });
}
```

---

## 3. Additional Critical Issues

### 3.1 Handler is Not Async

```typescript
// BUG: handlers are called synchronously, but agent processing is async
for (const handler of this.handlers) {
  handler(envelope); // fire-and-forget — no error handling, no backpressure
}
```

Should be:
```typescript
for (const handler of this.handlers) {
  try {
    await handler(envelope);
  } catch (err) {
    logger.error({ error: err.message }, 'Message handler failed');
  }
}
```

### 3.2 Channel Adapter Interface Too Narrow

```typescript
export interface ChannelAdapter {
  send(envelope: MessageEnvelope, response: string): Promise<void>;
}
```

Needs: `sendStream`, `edit`, `react`, `typingIndicator`, `sendMedia`, etc.

### 3.3 No Rate Limiting

No rate limiting on incoming Telegram messages. A user can spam messages and overwhelm the agent.

### 3.4 No Graceful Shutdown

Session state is in-memory. No graceful shutdown handler to flush to DB before exit.

---

## 4. Priority Fix List

| Priority | Fix | Effort |
|----------|-----|--------|
| P0 | Fix `get()` to load from DB (data loss bug) | 1h |
| P0 | Add typing indicators to Telegram | 30m |
| P0 | Switch to HTML parse mode (fix Markdown breakage) | 1h |
| P0 | Make message handlers async with error handling | 30m |
| P1 | Add streaming to Telegram (edit-based) | 4h |
| P1 | Replace naive compaction with LLM summarization | 4h |
| P1 | Add model-aware context window limits | 2h |
| P1 | Add graceful shutdown (flush to DB) | 2h |
| P1 | Track actual token usage from API responses | 2h |
| P2 | Add media handling (photos, voice, documents) | 4h |
| P2 | Add inline keyboard support | 3h |
| P2 | Add push-based subagent completion | 3h |
| P2 | Add pre-compaction memory flush | 3h |
| P2 | Add session write locks / crash recovery | 4h |
| P3 | Add rate limiting | 2h |
| P3 | Add parallel tool execution | 4h |
| P3 | Add per-session model pinning | 2h |
| P3 | Add tool result streaming/progress | 4h |

---

## 5. Architecture Comparison Summary

| Feature | Anorion | OpenClaw | Hermes |
|---------|---------|----------|--------|
| Streaming UX | ❌ Not connected | ✅ Full lifecycle | ⚠️ Partial |
| Context compaction | ⚠️ Truncation only | ✅ LLM + memory flush | ✅ LLM summarization |
| Token tracking | ⚠️ Char/4 estimate | ✅ Actual from API | ✅ Actual from API |
| Session persistence | ⚠️ In-memory + SQLite | ✅ JSONL + gateway | ⚠️ In-memory |
| Model fallback | ⚠️ Basic | ✅ Auth rotation + fallback chain | ⚠️ Basic |
| Telegram polish | ❌ Minimal | ✅ Full (typing, stream, media) | N/A |
| Subagents | ⚠️ Basic | ✅ Push-based, steerable | N/A |
| Memory | ⚠️ Key-value only | ✅ Markdown workspace + search | ⚠️ Trajectory only |
| Tool execution | ⚠️ Serial | ✅ Parallel + streaming | ⚠️ Serial |
| Crash recovery | ❌ None | ✅ Append-only JSONL | ❌ None |

**Bottom line:** Anorion is ~60% of the way to production. The P0 fixes (data loss, Telegram UX) are quick wins. The P1 fixes (streaming, compaction) are what make it feel like a real product vs a demo.
