// Discord Channel — text messages, reactions, threads via discord.js

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  Partials,
  type Snowflake,
} from 'discord.js';
import type { ChannelAdapter, InlineKeyboard, MediaAttachment } from './base';
import type { MessageEnvelope } from '../shared/types';
import { logger } from '../shared/logger';
import { nanoid } from 'nanoid';
import { splitMessage } from './telegram';
import { sttService } from '../voice/stt';
import { ttsService } from '../voice/tts';
import { convertAudio, detectFormat } from '../voice/audio';
import type { AudioFormat } from '../voice/types';

interface DiscordConfig {
  botToken: string;
  allowedGuilds: string[];
  allowedUsers: string[];
  defaultAgent: string;
  /** Max length per Discord message (2000 is the API limit) */
  maxMessageLength: number;
}

interface TrackedMessage {
  channelId: string;
  messageId: string;
  lastEditAt: number;
  currentText: string;
}

export class DiscordChannel implements ChannelAdapter {
  name = 'discord';
  private client: Client | null = null;
  private config: DiscordConfig;
  private handlers: ((envelope: MessageEnvelope) => void)[] = [];
  private running = false;
  private trackedMessages = new Map<string, TrackedMessage>();
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  private static STREAM_EDIT_INTERVAL_MS = 800;
  private static STREAM_MIN_DELTA = 15;

  constructor(config: Partial<DiscordConfig> & { botToken: string }) {
    this.config = {
      botToken: config.botToken,
      allowedGuilds: config.allowedGuilds ?? [],
      allowedUsers: config.allowedUsers ?? [],
      defaultAgent: config.defaultAgent ?? 'example',
      maxMessageLength: config.maxMessageLength ?? 2000,
    };
  }

  async start(): Promise<void> {
    if (!this.config.botToken) {
      logger.warn('Discord bot token not configured, skipping');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info({ tag: readyClient.user.tag }, 'Discord bot connected');
      this.running = true;
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      await this.handleMessage(msg);
    });

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      await this.handleReaction(reaction, user);
    });

    this.client.on(Events.ThreadCreate, async (thread) => {
      logger.info({ threadId: thread.id, name: thread.name }, 'Discord thread created');
    });

    this.client.on(Events.Error, (error) => {
      logger.error({ error: error.message }, 'Discord client error');
    });

    this.client.on(Events.ShardDisconnect, () => {
      logger.warn('Discord shard disconnected');
    });

    this.client.on(Events.ShardReconnecting, () => {
      logger.info('Discord shard reconnecting');
    });

    await this.client.login(this.config.botToken);
  }

  private isAllowed(msg: Message): boolean {
    // Ignore own messages
    if (msg.author.id === this.client?.user?.id) return false;

    // User allowlist check
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(msg.author.id)) {
      logger.warn({ userId: msg.author.id }, 'Unauthorized Discord user, ignoring');
      return false;
    }

    // Guild allowlist check (DMs bypass this)
    if (msg.guild && this.config.allowedGuilds.length > 0 && !this.config.allowedGuilds.includes(msg.guild.id)) {
      logger.warn({ guildId: msg.guild.id }, 'Unauthorized Discord guild, ignoring');
      return false;
    }

    return true;
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (!this.isAllowed(msg)) return;

    const isDM = !msg.guild;
    const channelId = msg.channel.id;
    const threadId = msg.channel.isThread() ? msg.channel.id : undefined;

    // Handle attachments — transcribe audio, describe others
    const attachments = msg.attachments.map((a) => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
    }));

    let text = msg.content;

    // Process audio attachments via STT
    const audioTypes = ['audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/webm', 'audio/ogg; codecs=opus'];
    for (const att of attachments) {
      if (att.contentType && audioTypes.some((t) => att.contentType!.startsWith(t.split(';')[0]!))) {
        try {
          const audioResp = await fetch(att.url);
          if (audioResp.ok) {
            const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
            const format = (detectFormat(audioBuffer) || att.contentType?.split('/')[1] || 'ogg') as AudioFormat;
            const result = await sttService.transcribe({
              buffer: audioBuffer,
              format,
            });
            if (result.text.trim()) {
              text = text ? `${text}\n[voice: ${result.text}]` : result.text;
              logger.info({ language: result.language, confidence: result.confidence }, 'Discord audio transcribed');
              continue;
            }
          }
        } catch (err) {
          logger.warn({ error: (err as Error).message }, 'Failed to transcribe Discord audio attachment');
        }
      }
      // Non-audio attachment
      const info = `[${att.contentType || 'file'}: ${att.name}]`;
      text = text ? `${text}\n${info}` : info;
    }

    if (!text.trim()) return;

    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: msg.author.id,
      text,
      channelId: `discord:${channelId}`,
      metadata: {
        channelType: 'discord',
        channelId,
        userId: msg.author.id,
        username: msg.author.username,
        displayName: msg.author.displayName,
        isDM,
        guildId: msg.guild?.id,
        threadId,
        messageId: msg.id,
        replyToMessageId: msg.reference?.messageId,
        hasAttachments: attachments.length > 0,
        attachments,
      },
      timestamp: Date.now(),
    };

    for (const h of this.handlers) h(envelope);
  }

  private async handleReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    if (user.id === this.client?.user?.id) return;

    // Fetch full reaction if partial
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }

    const msg = reaction.message;
    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: user.id,
      text: `[reaction:${reaction.emoji.name}]`,
      channelId: `discord:${msg.channel.id}`,
      metadata: {
        channelType: 'discord',
        channelId: msg.channel.id,
        userId: user.id,
        username: user.username,
        messageId: msg.id,
        emoji: reaction.emoji.name,
        emojiId: reaction.emoji.id,
        isReaction: true,
      },
      timestamp: Date.now(),
    };

    for (const h of this.handlers) h(envelope);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.trackedMessages.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.handlers.push(handler);
  }

  // ── Typing indicators ───────────────────────────────────────────

  async startTyping(chatId: string): Promise<void> {
    if (this.typingIntervals.has(chatId)) return;
    const channel = await this.resolveChannel(chatId);
    if (!channel || !channel.isTextBased()) return;

    try {
      await channel.sendTyping();
    } catch { /* ignore */ }

    const interval = setInterval(async () => {
      try {
        await channel.sendTyping();
      } catch { /* ignore */ }
    }, 4500);

    this.typingIntervals.set(chatId, interval);
  }

  stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async resolveChannel(chatId: string): Promise<TextChannel | DMChannel | ThreadChannel | null> {
    if (!this.client) return null;
    const raw = chatId.replace('discord:', '');
    try {
      const channel = await this.client.channels.fetch(raw as Snowflake);
      if (channel?.isTextBased()) return channel as TextChannel | DMChannel | ThreadChannel;
    } catch {
      // ignore
    }
    return null;
  }

  private resolveTargetChannelId(envelope: MessageEnvelope): string {
    return ((envelope.metadata?.channelId as string) || envelope.channelId?.replace('discord:', '') || '');
  }

  // ── Core send ───────────────────────────────────────────────────

  async send(envelope: MessageEnvelope, response: string): Promise<void> {
    const channelId = this.resolveTargetChannelId(envelope);
    if (!channelId) {
      logger.error({ envelope: envelope.id }, 'No channelId in envelope');
      return;
    }

    const channel = await this.resolveChannel(channelId);
    if (!channel) {
      logger.error({ channelId }, 'Could not resolve Discord channel');
      return;
    }

    const chunks = splitMessage(response, this.config.maxMessageLength);

    for (const chunk of chunks) {
      try {
        const options: Record<string, unknown> = {};
        // Reply to original message if present
        if (envelope.metadata?.messageId && chunks.length <= 1) {
          options.reply = { messageReference: envelope.metadata.messageId as string };
        }
        await channel.send({ content: chunk, ...options });
      } catch (err) {
        logger.error({ error: (err as Error).message, channelId }, 'Failed to send Discord message');
      }
    }
  }

  // ── Send media ──────────────────────────────────────────────────

  /** Convert text to speech and send as a Discord audio attachment */
  async sendVoiceNote(
    envelope: MessageEnvelope,
    text: string,
    opts?: { voice?: string; speed?: number; provider?: string },
  ): Promise<void> {
    const channelId = this.resolveTargetChannelId(envelope);
    if (!channelId) return;
    const channel = await this.resolveChannel(channelId);
    if (!channel) return;

    try {
      const ttsResult = await ttsService.synthesize(text, {
        voice: opts?.voice,
        speed: opts?.speed,
        format: 'mp3',
        adapter: opts?.provider,
      });

      await channel.send({
        files: [{ attachment: ttsResult.audio.buffer, name: 'voice.mp3' }],
      });
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to send Discord voice note, falling back to text');
      await this.send(envelope, text);
    }
  }

  async sendMedia(envelope: MessageEnvelope, media: MediaAttachment): Promise<void> {
    const channelId = this.resolveTargetChannelId(envelope);
    if (!channelId) return;

    const channel = await this.resolveChannel(channelId);
    if (!channel) return;

    try {
      const attachment = typeof media.data === 'string'
        ? { attachment: media.data, name: media.filename || 'file' }
        : { attachment: Buffer.from(media.data), name: media.filename || 'file' };

      await channel.send({
        content: media.caption || undefined,
        files: [attachment],
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, channelId, type: media.type }, 'Failed to send Discord media');
    }
  }

  // ── Send with keyboard (as buttons) ─────────────────────────────

  async sendWithKeyboard(
    envelope: MessageEnvelope,
    response: string,
    keyboard: InlineKeyboard,
  ): Promise<void> {
    const channelId = this.resolveTargetChannelId(envelope);
    if (!channelId) return;

    const channel = await this.resolveChannel(channelId);
    if (!channel) return;

    // Discord doesn't have inline keyboards — render as text buttons
    const buttonRows = keyboard.buttons
      .map((row) => row.map((btn) => btn.url ? `[${btn.text}](${btn.url})` : `\`${btn.text}\``)
      .join('  '))
      .join('\n');

    const message = response.length > 0 ? `${response}\n${buttonRows}` : buttonRows;

    try {
      await channel.send({ content: message });
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to send Discord keyboard message');
    }
  }

  // ── Streaming support ───────────────────────────────────────────

  async startStreaming(envelope: MessageEnvelope, initialText = '...'): Promise<string> {
    const channelId = this.resolveTargetChannelId(envelope);
    if (!channelId) return '';

    const channel = await this.resolveChannel(channelId);
    if (!channel) return '';

    try {
      const msg = await channel.send({ content: initialText });
      const trackId = `${channelId}:${msg.id}`;
      this.trackedMessages.set(trackId, {
        channelId,
        messageId: msg.id,
        lastEditAt: 0,
        currentText: initialText,
      });
      return trackId;
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to start Discord streaming message');
      return '';
    }
  }

  async editStreamingMessage(trackId: string, text: string): Promise<void> {
    const tracked = this.trackedMessages.get(trackId);
    if (!tracked || !this.client) return;

    const now = Date.now();
    const delta = Math.abs(text.length - tracked.currentText.length);

    if (now - tracked.lastEditAt < DiscordChannel.STREAM_EDIT_INTERVAL_MS && delta < DiscordChannel.STREAM_MIN_DELTA) {
      return;
    }

    tracked.currentText = text;

    try {
      const channel = await this.resolveChannel(tracked.channelId);
      if (!channel) return;
      const msg = await channel.messages.fetch(tracked.messageId as Snowflake);
      await msg.edit({ content: text });
      tracked.lastEditAt = now;
    } catch {
      // Ignore edit failures (rate limit, message deleted, etc.)
    }
  }

  async finishStreaming(trackId: string, finalText: string): Promise<void> {
    const tracked = this.trackedMessages.get(trackId);
    if (!tracked || !this.client) return;

    const channel = await this.resolveChannel(tracked.channelId);
    if (!channel) {
      this.trackedMessages.delete(trackId);
      return;
    }

    const chunks = splitMessage(finalText, this.config.maxMessageLength);

    // Edit tracked message with first chunk
    if (chunks.length > 0) {
      try {
        const msg = await channel.messages.fetch(tracked.messageId as Snowflake);
        await msg.edit({ content: chunks[0] });
      } catch {
        // Ignore
      }
    }

    // Send remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      try {
        await channel.send({ content: chunks[i] });
      } catch {
        // Ignore
      }
    }

    this.trackedMessages.delete(trackId);
  }
}
