import type { Message, MessagePriority } from '../shared/types';
import { logger } from '../shared/logger';

interface CompactOptions {
  maxContextTokens: number;
  thresholdPercent: number;
  keepFirstMessages: number;
  keepLastMessages: number;
  systemTokenBudget: number;
}

const DEFAULT_OPTIONS: CompactOptions = {
  maxContextTokens: 128_000,
  thresholdPercent: 0.8,
  keepFirstMessages: 4,
  keepLastMessages: 20,
  systemTokenBudget: 4_000,
};

/** Rough token estimation: ~4 chars per token */
function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    if (m.toolResults) chars += JSON.stringify(m.toolResults).length;
  }
  return Math.ceil(chars / 4);
}

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function shouldCompact(messages: Message[], options?: Partial<CompactOptions>): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (messages.length <= opts.keepFirstMessages + opts.keepLastMessages) return false;
  const tokens = estimateTokens(messages);
  return tokens > opts.maxContextTokens * opts.thresholdPercent;
}

/**
 * Priority-based context compaction.
 * - Always keeps system messages and the first N messages (system prompt area)
 * - Always keeps the last N messages (recent context)
 * - Middle messages are kept based on priority: tool results → assistant → user
 * - Tool results and tool-heavy assistant messages get higher priority
 */
export function compactMessages(
  messages: Message[],
  options?: Partial<CompactOptions>,
): { messages: Message[]; tokensSaved: number } {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalTokens = estimateTokens(messages);

  if (messages.length <= opts.keepFirstMessages + opts.keepLastMessages) {
    return { messages, tokensSaved: 0 };
  }

  const first = messages.slice(0, opts.keepFirstMessages);
  const last = messages.slice(-opts.keepLastMessages);
  const middle = messages.slice(opts.keepFirstMessages, -opts.keepLastMessages);

  if (middle.length === 0) {
    return { messages, tokensSaved: 0 };
  }

  // Assign priority scores to middle messages
  const scored = middle.map((m) => {
    let score = PRIORITY_ORDER[m.priority ?? 'normal'];
    // Boost tool results and tool-call-bearing messages
    if (m.role === 'tool') score -= 0.5;
    if (m.toolResults && m.toolResults.length > 0) score -= 0.3;
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) score -= 0.2;
    return { message: m, score };
  });

  // Sort by score (lower = higher priority), keep until budget
  scored.sort((a, b) => a.score - b.score);

  const kept: Message[] = [];
  let budget = opts.maxContextTokens - estimateTokens(first) - estimateTokens(last);

  for (const { message } of scored) {
    const msgTokens = estimateTokens([message]);
    if (budget - msgTokens >= 0) {
      kept.push(message);
      budget -= msgTokens;
    }
  }

  // Re-sort kept messages back to original order
  kept.sort((a, b) => {
    const ai = middle.indexOf(a);
    const bi = middle.indexOf(b);
    return ai - bi;
  });

  // If we dropped any middle messages, insert a summary marker
  const dropped = middle.length - kept.length;
  const compacted: Message[] = dropped > 0
    ? [...first, {
        id: 'compact-summary',
        sessionId: middle[0]?.sessionId || '',
        agentId: middle[0]?.agentId || '',
        role: 'system' as const,
        content: `[Context compacted — ${dropped} lower-priority messages removed to fit context window]`,
        createdAt: new Date().toISOString(),
        priority: 'critical' as const,
      }, ...kept, ...last]
    : [...first, ...kept, ...last];

  const newTokens = estimateTokens(compacted);
  const saved = originalTokens - newTokens;

  logger.info(
    { original: messages.length, compacted: compacted.length, tokensSaved: saved, dropped },
    'Context compacted (priority-based)',
  );

  return { messages: compacted, tokensSaved: saved };
}
