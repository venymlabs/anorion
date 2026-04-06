// StreamingBuffer — manages partial responses with debounced flushes
// Accumulates tokens from the provider and flushes to channels at a controlled rate

import type { StreamingConfig } from '../shared/types';
import { DEFAULT_STREAMING_CONFIG } from '../shared/types';
import { logger } from '../shared/logger';

export interface StreamingBufferOptions {
  config?: Partial<StreamingConfig>;
  /** Called when the buffer flushes accumulated text */
  onFlush: (text: string) => Promise<void>;
  /** Called when streaming completes with final text */
  onFinish: (text: string) => Promise<void>;
  /** Called on error */
  onError?: (error: Error) => void;
  /** Optional abort signal — buffer will stop accepting data when aborted */
  signal?: AbortSignal;
}

/**
 * StreamingBuffer accumulates text deltas and flushes them at a controlled rate.
 *
 * Flush triggers:
 * - Enough chars accumulated (minDeltaChars)
 * - Enough time elapsed since last flush (updateIntervalMs)
 * - Max buffer time exceeded (maxBufferMs)
 * - Explicit finish
 *
 * Backpressure:
 * - Tracks pending flush operations to avoid queueing too many concurrent writes
 * - If flushes are backing up (>maxPendingFlushes), append() drops delta to prevent OOM
 * - Honors AbortSignal for clean cancellation
 */
export class StreamingBuffer {
  private accumulated = '';
  private lastFlushAt = 0;
  private lastDeltaAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private maxBufferTimer: ReturnType<typeof setTimeout> | null = null;
  private config: StreamingConfig;
  private onFlush: (text: string) => Promise<void>;
  private onFinish: (text: string) => Promise<void>;
  private onError?: (error: Error) => void;
  private aborted = false;
  private flushing = false;
  private pendingFlushCount = 0;
  private static readonly MAX_PENDING_FLUSHES = 3;
  private signal?: AbortSignal;

  constructor(options: StreamingBufferOptions) {
    this.config = { ...DEFAULT_STREAMING_CONFIG, ...options.config };
    this.onFlush = options.onFlush;
    this.onFinish = options.onFinish;
    this.onError = options.onError;
    this.signal = options.signal;

    // Link abort signal
    if (this.signal) {
      if (this.signal.aborted) {
        this.aborted = true;
      } else {
        this.signal.addEventListener('abort', () => this.abort(), { once: true });
      }
    }
  }

  /** Append a text delta and schedule a flush if needed.
   *  Returns false if the delta was dropped due to backpressure. */
  append(text: string): boolean {
    if (this.aborted) return false;

    // Backpressure: if too many flushes are pending, drop the delta
    if (this.pendingFlushCount >= StreamingBuffer.MAX_PENDING_FLUSHES) {
      logger.debug(
        { pending: this.pendingFlushCount },
        'StreamingBuffer backpressure — dropping delta',
      );
      return false;
    }

    this.accumulated += text;
    this.lastDeltaAt = Date.now();

    // Schedule interval-based flush
    this.scheduleIntervalFlush();

    // Ensure max-buffer timer is running
    this.ensureMaxBufferTimer();

    return true;
  }

  /** Mark streaming as complete — flushes remaining content and calls onFinish */
  async finish(): Promise<void> {
    if (this.aborted) return;

    this.clearTimers();
    this.unlinkSignal();

    if (this.accumulated.length > 0) {
      try {
        await this.onFinish(this.accumulated);
      } catch (err) {
        this.handleError(err as Error);
      }
    }

    this.lastFlushAt = Date.now();
  }

  /** Abort streaming — cleans up timers without flushing */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.clearTimers();
    this.unlinkSignal();
    this.accumulated = '';
  }

  /** Get the current accumulated text */
  getText(): string {
    return this.accumulated;
  }

  /** Whether the buffer has been aborted */
  get isAborted(): boolean {
    return this.aborted;
  }

  /** Current number of chars accumulated since last flush */
  get pendingChars(): number {
    return this.accumulated.length - (this.lastFlushTextLength ?? 0);
  }

  private unlinkSignal(): void {
    // Signal cleanup handled by { once: true } on addEventListener
  }

  private scheduleIntervalFlush(): void {
    if (this.flushTimer || this.aborted) return;

    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    const remaining = Math.max(0, this.config.updateIntervalMs - elapsed);

    if (remaining === 0) {
      // Enough time has passed — check if we have enough chars
      const charDelta = this.accumulated.length - (this.lastFlushTextLength ?? 0);
      if (charDelta >= this.config.minDeltaChars) {
        void this.flush();
        return;
      }
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.aborted) return;
      void this.flush();
    }, remaining);
  }

  private ensureMaxBufferTimer(): void {
    if (this.maxBufferTimer || this.aborted) return;

    this.maxBufferTimer = setTimeout(() => {
      this.maxBufferTimer = null;
      if (this.aborted) return;

      // Force flush if we've been buffering too long
      if (this.accumulated.length > 0) {
        void this.flush();
      }

      // Re-arm if still active
      this.ensureMaxBufferTimer();
    }, this.config.maxBufferMs);
  }

  private lastFlushTextLength: number | null = null;

  private async flush(): Promise<void> {
    if (this.flushing || this.aborted) return;
    if (this.accumulated.length === 0) return;

    // Check min delta since last flush
    const lastLen = this.lastFlushTextLength ?? 0;
    const charDelta = this.accumulated.length - lastLen;
    if (charDelta < this.config.minDeltaChars) return;

    this.flushing = true;
    this.pendingFlushCount++;
    this.lastFlushTextLength = this.accumulated.length;
    this.lastFlushAt = Date.now();

    try {
      await this.onFlush(this.accumulated);
    } catch (err) {
      this.handleError(err as Error);
    } finally {
      this.flushing = false;
      this.pendingFlushCount = Math.max(0, this.pendingFlushCount - 1);
    }
  }

  private clearTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.maxBufferTimer) {
      clearTimeout(this.maxBufferTimer);
      this.maxBufferTimer = null;
    }
  }

  private handleError(err: Error): void {
    if (this.onError) {
      this.onError(err);
    } else {
      logger.error({ error: err.message }, 'StreamingBuffer error');
    }
  }
}

/**
 * Pipe an async iterable of stream chunks through a StreamingBuffer to a channel adapter.
 * Handles the full lifecycle: startStreaming → editStreamingMessage → finishStreaming.
 *
 * Supports AbortSignal propagation and backpressure-aware buffering.
 */
export async function pipeStreamToChannel(
  stream: AsyncIterable<{ sessionId: string; chunk: { type: string; content?: string; toolCall?: any; toolResult?: any } }>,
  channel: {
    startStreaming?: (envelope: any, initialText?: string) => Promise<string>;
    editStreamingMessage?: (messageId: string, text: string) => Promise<void>;
    finishStreaming?: (messageId: string, text: string) => Promise<void>;
    startTyping?: (chatId: string) => Promise<void>;
    stopTyping?: (chatId: string) => void;
    send: (envelope: any, response: string) => Promise<void>;
  },
  envelope: any,
  config?: Partial<StreamingConfig>,
  signal?: AbortSignal,
): Promise<string> {
  const fullConfig: StreamingConfig = { ...DEFAULT_STREAMING_CONFIG, ...config };

  // If channel doesn't support streaming or streaming is disabled, fall back to buffered
  if (!fullConfig.enabled || !channel.startStreaming || !channel.editStreamingMessage || !channel.finishStreaming) {
    let fullContent = '';
    for await (const { chunk } of stream) {
      if (signal?.aborted) break;
      if (chunk.type === 'delta' && chunk.content) {
        fullContent += chunk.content;
      }
    }
    if (signal?.aborted) return fullContent;
    await channel.send(envelope, fullContent || 'No response generated.');
    return fullContent;
  }

  // Start streaming message on the channel
  const trackId = await channel.startStreaming(envelope, fullConfig.initialText);
  if (!trackId) {
    // Fallback if startStreaming failed
    let fullContent = '';
    for await (const { chunk } of stream) {
      if (signal?.aborted) break;
      if (chunk.type === 'delta' && chunk.content) {
        fullContent += chunk.content;
      }
    }
    if (signal?.aborted) return fullContent;
    await channel.send(envelope, fullContent || 'No response generated.');
    return fullContent;
  }

  // Start typing indicator
  const chatId = envelope.metadata?.chatId as string | undefined;
  if (fullConfig.showTyping && chatId && channel.startTyping) {
    await channel.startTyping(chatId).catch(() => {});
  }

  // Set up buffer for debounced edits with abort signal
  let finalText = '';
  const buffer = new StreamingBuffer({
    config: fullConfig,
    signal,
    onFlush: async (text) => {
      await channel.editStreamingMessage!(trackId, text);
    },
    onFinish: async (text) => {
      finalText = text;
      await channel.finishStreaming!(trackId, text);
    },
    onError: (err) => {
      logger.error({ error: err.message, trackId }, 'Streaming to channel failed');
    },
  });

  try {
    for await (const { chunk } of stream) {
      if (buffer.isAborted) break;

      if (chunk.type === 'delta' && chunk.content) {
        buffer.append(chunk.content);
      }
    }

    if (!buffer.isAborted) {
      await buffer.finish();
    }
  } catch (err) {
    const partial = buffer.getText();
    buffer.abort();
    logger.error({ error: (err as Error).message }, 'Stream pipe error');

    // Try to send whatever we accumulated as a final message
    if (partial) {
      try {
        await channel.finishStreaming!(trackId, partial);
      } catch {
        await channel.send(envelope, partial).catch(() => {});
      }
    }
    finalText = partial;
  } finally {
    // Stop typing indicator
    if (chatId && channel.stopTyping) {
      channel.stopTyping(chatId);
    }
  }

  return finalText;
}
