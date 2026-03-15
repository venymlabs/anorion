import type { Message } from '../shared/types';
import { logger } from '../shared/logger';

interface CompactOptions {
  maxContextTokens: number;
  thresholdPercent: number;
  keepFirstMessages: number;
  keepLastMessages: number;
}

const DEFAULT_OPTIONS: CompactOptions = {
  maxContextTokens: 128_000,
  thresholdPercent: 0.8,
  keepFirstMessages: 4,
  keepLastMessages: 20,
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

export function shouldCompact(messages: Message[], options?: Partial<CompactOptions>): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (messages.length <= opts.keepFirstMessages + opts.keepLastMessages) return false;
  const tokens = estimateTokens(messages);
  return tokens > opts.maxContextTokens * opts.thresholdPercent;
}

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

  // Summarize the middle — for now, truncate with a marker
  // Future: use LLM call for proper summarization
  const summaryTokens = estimateTokens(middle);
  const summaryContent = middle
    .map((m) => `[${m.role}] ${m.content.slice(0, 100)}`)
    .join('\n');

  const summaryMessage: Message = {
    id: 'compact-summary',
    sessionId: middle[0]?.sessionId || '',
    agentId: middle[0]?.agentId || '',
    role: 'system',
    content: `[Context compacted — ${middle.length} messages summarized (${summaryTokens} tokens estimated)]\n\n${summaryContent}`,
    createdAt: new Date().toISOString(),
  };

  const compacted = [...first, summaryMessage, ...last];
  const newTokens = estimateTokens(compacted);
  const saved = originalTokens - newTokens;

  logger.info(
    { original: messages.length, compacted: compacted.length, tokensSaved: saved },
    'Context compacted',
  );

  return { messages: compacted, tokensSaved: saved };
}
