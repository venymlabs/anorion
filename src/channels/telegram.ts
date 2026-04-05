import { Bot, type Context, type RawApi, InlineKeyboard as GrammyInlineKeyboard, InputFile } from 'grammy';
import type {
  ChannelAdapter,
  InlineKeyboard,
  MediaAttachment,
} from './base';
import type { MessageEnvelope } from '../shared/types';
import { logger } from '../shared/logger';
import { nanoid } from 'nanoid';

interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
  defaultAgent: string;
}

// ── MarkdownV2 escaping ──────────────────────────────────────────────

const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_SPECIAL, (ch) => `\\${ch}`);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Message splitter ─────────────────────────────────────────────────

export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to respect code blocks
    const lastTriple = remaining.lastIndexOf('```', maxLen);
    const prevTriple = remaining.lastIndexOf('```', maxLen - 3);
    if (lastTriple > 0 && prevTriple < lastTriple) {
      // We'd cut inside an open code block; split and balance
      chunks.push(remaining.slice(0, lastTriple) + '\n```');
      remaining = '```\n' + remaining.slice(lastTriple);
      continue;
    }

    // Try newline
    let cutAt = -1;
    const nl = remaining.lastIndexOf('\n', maxLen);
    if (nl > maxLen * 0.3) {
      cutAt = nl + 1;
    } else {
      const sp = remaining.lastIndexOf(' ', maxLen);
      if (sp > maxLen * 0.3) {
        cutAt = sp + 1;
      } else {
        cutAt = maxLen;
      }
    }

    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }

  return chunks;
}

// ── Typing indicator manager ─────────────────────────────────────────

class TypingManager {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private api: RawApi | null = null;

  setApi(api: RawApi) {
    this.api = api;
  }

  async start(chatId: string | number): Promise<void> {
    const key = String(chatId);
    if (!this.api || this.timers.has(key)) return;
    try {
      await this.api.sendChatAction({ chat_id: chatId, action: 'typing' });
    } catch { /* ignore */ }
    const timer = setInterval(async () => {
      try {
        await this.api!.sendChatAction({ chat_id: chatId, action: 'typing' });
      } catch { /* ignore */ }
    }, 4500);
    this.timers.set(key, timer);
  }

  stop(chatId: string | number): void {
    const key = String(chatId);
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  stopAll(): void {
    for (const key of Array.from(this.timers.keys())) {
      this.stop(key);
    }
  }
}

// ── Send queue ───────────────────────────────────────────────────────

class SendQueue {
  private queue: (() => Promise<void>)[] = [];
  private processing = false;
  private minDelayMs: number;

  constructor(minDelayMs = 35) {
    this.minDelayMs = minDelayMs;
  }

  enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      try {
        await fn();
      } catch (err) {
        logger.debug({ error: (err as Error).message }, 'SendQueue item failed');
      }
      await new Promise((r) => setTimeout(r, this.minDelayMs));
    }
    this.processing = false;
  }
}

// ── Tracked message (for streaming edits) ────────────────────────────

interface TrackedMessage {
  chatId: string | number;
  messageId: number;
  lastEditAt: number;
  currentText: string;
}

// ── TelegramChannel ──────────────────────────────────────────────────

export class TelegramChannel implements ChannelAdapter {
  name = 'telegram';
  private bot: Bot | null = null;
  private config: TelegramConfig;
  private handlers: ((envelope: MessageEnvelope) => void)[] = [];
  private running = false;
  private typing = new TypingManager();
  private sendQueue = new SendQueue();
  private trackedMessages = new Map<string, TrackedMessage>();

  private static STREAM_EDIT_INTERVAL_MS = 800;
  private static STREAM_MIN_DELTA = 15;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.botToken) {
      logger.warn('Telegram bot token not configured, skipping');
      return;
    }

    this.bot = new Bot(this.config.botToken);
    this.typing.setApi(this.bot.api.raw);

    this.bot.on('message:text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });

    // Handle photos
    this.bot.on('message:photo', async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const caption = ctx.message?.caption || '';
      const photo = ctx.message?.photo;
      const largest = photo?.[photo.length - 1];
      let fileUrl: string | undefined;
      try {
        const f = await ctx.getFile();
        if (f.file_path) {
          fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${f.file_path}`;
        }
      } catch { /* ignore */ }

      this.dispatchMessage(ctx, caption ? `[photo] ${caption}` : '[photo]', {
        mediaType: 'photo',
        fileUrl,
        fileId: largest?.file_id,
      });
    });

    // Handle documents
    this.bot.on('message:document', async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const doc = ctx.message?.document;
      let fileUrl: string | undefined;
      try {
        const f = await ctx.getFile();
        if (f.file_path) {
          fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${f.file_path}`;
        }
      } catch { /* ignore */ }

      this.dispatchMessage(ctx, ctx.message?.caption || `[document: ${doc?.file_name || 'file'}]`, {
        mediaType: 'document',
        fileName: doc?.file_name,
        mimeType: doc?.mime_type,
        fileSize: doc?.file_size,
        fileId: doc?.file_id,
        fileUrl,
      });
    });

    // Handle voice
    this.bot.on('message:voice', async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const voice = ctx.message?.voice;
      let fileUrl: string | undefined;
      try {
        const f = await ctx.getFile();
        if (f.file_path) {
          fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${f.file_path}`;
        }
      } catch { /* ignore */ }

      this.dispatchMessage(ctx, '[voice message]', {
        mediaType: 'voice',
        duration: voice?.duration,
        fileId: voice?.file_id,
        fileUrl,
      });
    });

    this.bot.on('edited_message:text', async () => {
      logger.info('Telegram message edited (noted, not re-processed)');
    });

    this.bot.on('message_reaction', async (ctx) => {
      logger.info(
        { userId: ctx.update.message_reaction?.user?.id },
        'Telegram reaction received',
      );
    });

    // Handle callback queries (inline keyboard presses)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const userId = String(ctx.from.id);

      await ctx.answerCallbackQuery();

      const envelope: MessageEnvelope = {
        id: nanoid(12),
        from: userId,
        text: data,
        channelId: `telegram:${chatId}`,
        metadata: {
          channelType: 'telegram',
          chatId: String(chatId),
          userId,
          username: ctx.from.username,
          isCallback: true,
          callbackQueryId: ctx.callbackQuery.id,
        },
        timestamp: Date.now(),
      };
      for (const h of this.handlers) h(envelope);
    });

    this.bot.catch((err) => {
      logger.error({ error: err.message }, 'Telegram bot error');
    });

    logger.info('Starting Telegram bot (long polling)...');
    await this.bot.start({
      onStart: (info) => {
        logger.info({ username: info.username }, 'Telegram bot started');
      },
    });

    this.running = true;
  }

  private isAllowed(ctx: Context): boolean {
    const userId = String(ctx.from?.id);
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
      logger.warn({ userId }, 'Unauthorized Telegram user, ignoring');
      return false;
    }
    return true;
  }

  private dispatchMessage(
    ctx: Context,
    text: string,
    extraMeta: Record<string, unknown> = {},
  ): void {
    const userId = String(ctx.from!.id);
    const chatId = String(ctx.chat!.id);

    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: userId,
      text,
      channelId: `telegram:${chatId}`,
      metadata: {
        channelType: 'telegram',
        chatId,
        userId,
        username: ctx.from?.username,
        messageId: ctx.message?.message_id,
        ...extraMeta,
      },
      timestamp: Date.now(),
    };

    for (const h of this.handlers) h(envelope);
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;
    this.dispatchMessage(ctx, ctx.message?.text || '');
  }

  stop(): Promise<void> {
    this.running = false;
    this.typing.stopAll();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    return Promise.resolve();
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.handlers.push(handler);
  }

  // ── Typing indicators ───────────────────────────────────────────

  async startTyping(chatId: string): Promise<void> {
    await this.typing.start(chatId);
  }

  stopTyping(chatId: string): void {
    this.typing.stop(chatId);
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private resolveChatId(envelope: MessageEnvelope): string | number | undefined {
    const raw = (envelope.metadata?.chatId || envelope.channelId?.replace('telegram:', '')) as string | undefined;
    if (!raw) return undefined;
    const num = Number(raw);
    return Number.isNaN(num) ? raw : num;
  }

  // ── Core send ───────────────────────────────────────────────────

  async send(envelope: MessageEnvelope, response: string): Promise<void> {
    if (!this.bot) {
      logger.error('Telegram bot not running, cannot send');
      return;
    }

    const chatId = this.resolveChatId(envelope);
    if (!chatId) {
      logger.error({ envelope: envelope.id }, 'No chatId in envelope');
      return;
    }

    const replyToId = envelope.metadata?.messageId as number | undefined;
    const chunks = splitMessage(response, 4096);

    for (let i = 0; i < chunks.length; i++) {
      await this.sendChunk(chatId, chunks[i], i === 0 ? replyToId : undefined);
    }
  }

  private async sendChunk(
    chatId: string | number,
    text: string,
    replyToId?: number,
    replyMarkup?: GrammyInlineKeyboard,
  ): Promise<void> {
    if (!this.bot) return;

    const baseOpts = {
      ...(replyToId ? { reply_to_message_id: replyToId } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      link_preview_options: { is_disabled: true } as const,
    };

    // Try MarkdownV2 → HTML → plain
    for (const parse_mode of ['MarkdownV2', 'HTML', undefined] as const) {
      try {
        await this.bot.api.sendMessage(chatId, text, {
          ...baseOpts,
          ...(parse_mode ? { parse_mode } : {}),
        });
        return;
      } catch {
        continue;
      }
    }

    logger.error({ chatId }, 'All parse modes failed for message');
  }

  // ── Send with inline keyboard ───────────────────────────────────

  async sendWithKeyboard(
    envelope: MessageEnvelope,
    response: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    if (!this.bot) return;

    const chatId = this.resolveChatId(envelope);
    if (!chatId) return;

    const replyMarkup = new GrammyInlineKeyboard(
      keyboard.buttons.map((row) =>
        row.map((btn) => {
          if (btn.url) return { text: btn.text, url: btn.url };
          return { text: btn.text, callback_data: btn.callback_data || btn.text };
        }),
      ),
    );

    const replyToId = envelope.metadata?.messageId as number | undefined;

    for (const parse_mode of ['MarkdownV2', 'HTML', undefined] as const) {
      try {
        await this.bot.api.sendMessage(chatId, response, {
          ...(parse_mode ? { parse_mode } : {}),
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
          ...(replyToId ? { reply_to_message_id: replyToId } : {}),
        });
        return;
      } catch {
        continue;
      }
    }
  }

  // ── Send media ──────────────────────────────────────────────────

  async sendMedia(envelope: MessageEnvelope, media: MediaAttachment): Promise<void> {
    if (!this.bot) return;

    const chatId = this.resolveChatId(envelope);
    if (!chatId) return;

    const opts = media.caption ? { caption: media.caption } : {};
    const source: string | InputFile = typeof media.data === 'string'
      ? media.data
      : new InputFile(media.data, media.filename);

    try {
      switch (media.type) {
        case 'photo':
          await this.bot.api.sendPhoto(chatId, source, opts);
          break;
        case 'document':
          await this.bot.api.sendDocument(chatId, source, {
            ...opts,
            ...(media.filename ? { filename: media.filename } : {}),
          });
          break;
        case 'voice':
          await this.bot.api.sendVoice(chatId, source, opts);
          break;
        case 'video':
          await this.bot.api.sendVideo(chatId, source, opts);
          break;
      }
    } catch (err) {
      logger.error(
        { error: (err as Error).message, chatId, type: media.type },
        'Failed to send media',
      );
    }
  }

  // ── Streaming support ───────────────────────────────────────────

  async startStreaming(envelope: MessageEnvelope, initialText = '…'): Promise<string> {
    if (!this.bot) return '';

    const chatId = this.resolveChatId(envelope);
    if (!chatId) return '';

    try {
      const msg = await this.bot.api.sendMessage(chatId, initialText, {
        reply_to_message_id: envelope.metadata?.messageId as number | undefined,
      });

      const trackId = `${chatId}:${msg.message_id}`;
      this.trackedMessages.set(trackId, {
        chatId,
        messageId: msg.message_id,
        lastEditAt: 0,
        currentText: initialText,
      });

      return trackId;
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to start streaming message');
      return '';
    }
  }

  async editStreamingMessage(trackId: string, text: string): Promise<void> {
    const tracked = this.trackedMessages.get(trackId);
    if (!tracked || !this.bot) return;

    const now = Date.now();
    const delta = Math.abs(text.length - tracked.currentText.length);

    if (
      now - tracked.lastEditAt < TelegramChannel.STREAM_EDIT_INTERVAL_MS &&
      delta < TelegramChannel.STREAM_MIN_DELTA
    ) {
      return;
    }

    // Update tracked text even if edit fails (to track delta for next attempt)
    tracked.currentText = text;

    try {
      await this.bot.api.editMessageText(tracked.chatId, tracked.messageId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      tracked.lastEditAt = now;
    } catch {
      // Silently ignore (message unchanged, rate limit, parse error)
    }
  }

  async finishStreaming(trackId: string, finalText: string): Promise<void> {
    const tracked = this.trackedMessages.get(trackId);
    if (!tracked || !this.bot) return;

    const chunks = splitMessage(finalText, 4096);

    // Edit tracked message with first chunk
    if (chunks.length > 0) {
      for (const parse_mode of ['MarkdownV2', 'HTML', undefined] as const) {
        try {
          await this.bot.api.editMessageText(tracked.chatId, tracked.messageId, chunks[0], {
            ...(parse_mode ? { parse_mode } : {}),
            link_preview_options: { is_disabled: true },
          });
          break;
        } catch {
          continue;
        }
      }
    }

    // Send remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      await this.sendChunk(tracked.chatId, chunks[i]);
    }

    this.trackedMessages.delete(trackId);
  }
}
