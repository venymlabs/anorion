import { Bot, type Context } from 'grammy';
import type { ChannelAdapter } from './base';
import type { MessageEnvelope } from '../shared/types';
import { logger } from '../shared/logger';
import { nanoid } from 'nanoid';

interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
  defaultAgent: string;
}

export class TelegramChannel implements ChannelAdapter {
  name = 'telegram';
  private bot: Bot | null = null;
  private config: TelegramConfig;
  private handlers: ((envelope: MessageEnvelope) => void)[] = [];
  private running = false;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.botToken) {
      logger.warn('Telegram bot token not configured, skipping');
      return;
    }

    this.bot = new Bot(this.config.botToken);

    this.bot.on('message:text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });

    this.bot.on('edited_message:text', async (ctx) => {
      logger.info(
        { userId: ctx.from?.id, chatId: ctx.chat.id },
        'Telegram message edited (noted, not re-processed)',
      );
    });

    this.bot.on('message_reaction', async (ctx) => {
      logger.info(
        { userId: ctx.update.message_reaction?.user?.id },
        'Telegram reaction received',
      );
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

  private async handleTextMessage(ctx: Context): Promise<void> {
    const userId = String(ctx.from?.id);
    const chatId = String(ctx.chat.id);

    // Check allowed users
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
      logger.warn({ userId }, 'Unauthorized Telegram user, ignoring');
      return;
    }

    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: userId,
      text: ctx.message?.text || '',
      channelId: `telegram:${chatId}`,
      metadata: {
        channelType: 'telegram',
        chatId,
        userId,
        username: ctx.from?.username,
        messageId: ctx.message?.message_id,
      },
      timestamp: Date.now(),
    };

    for (const handler of this.handlers) {
      handler(envelope);
    }
  }

  stop(): Promise<void> {
    this.running = false;
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    return Promise.resolve();
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.handlers.push(handler);
  }

  async send(envelope: MessageEnvelope, response: string): Promise<void> {
    if (!this.bot) {
      logger.error('Telegram bot not running, cannot send');
      return;
    }

    const chatId = envelope.metadata?.chatId || envelope.channelId?.replace('telegram:', '');
    if (!chatId) {
      logger.error({ envelope: envelope.id }, 'No chatId in envelope, cannot send');
      return;
    }

    try {
      // Telegram has 4096 char limit per message
      const chunks = splitMessage(response, 4096);
      let replyToId: number | undefined;

      if (envelope.metadata?.messageId) {
        replyToId = envelope.metadata.messageId as number;
      }

      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, {
          reply_to_message_id: replyToId,
          parse_mode: 'Markdown',
        });
        // Only reply to the original message on the first chunk
        replyToId = undefined;
      }
    } catch (err) {
      logger.error({ error: (err as Error).message, chatId }, 'Failed to send Telegram message');
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      // Try to break at newline
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
