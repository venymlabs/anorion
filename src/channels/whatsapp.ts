// WhatsApp Channel — text, media, groups via @whiskeysockets/baileys

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
  type proto,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import type { ChannelAdapter, MediaAttachment } from './base';
import type { MessageEnvelope } from '../shared/types';
import { logger } from '../shared/logger';
import { nanoid } from 'nanoid';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { writeFile } from 'fs/promises';

interface WhatsAppConfig {
  /** Directory to store auth state (session data) */
  authDir: string;
  /** Phone numbers allowed to interact (with country code, no +) */
  allowedNumbers: string[];
  /** Allowed group JIDs (empty = allow all groups) */
  allowedGroups: string[];
  defaultAgent: string;
  /** Whether to handle group messages */
  handleGroups: boolean;
  /** Bot prefix for group commands (e.g. '!') */
  groupPrefix: string;
}

export class WhatsAppChannel implements ChannelAdapter {
  name = 'whatsapp';
  private sock: WASocket | null = null;
  private config: WhatsAppConfig;
  private handlers: ((envelope: MessageEnvelope) => void)[] = [];
  private running = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(config: Partial<WhatsAppConfig>) {
    this.config = {
      authDir: config.authDir ?? './data/whatsapp-auth',
      allowedNumbers: config.allowedNumbers ?? [],
      allowedGroups: config.allowedGroups ?? [],
      defaultAgent: config.defaultAgent ?? 'example',
      handleGroups: config.handleGroups ?? true,
      groupPrefix: config.groupPrefix ?? '!',
    };
  }

  async start(): Promise<void> {
    // Ensure auth directory exists
    if (!existsSync(this.config.authDir)) {
      mkdirSync(this.config.authDir, { recursive: true });
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: Browsers.ubuntu('Desktop'),
      logger: {
        level: 'silent',
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        trace: () => {},
        child: () => ({ level: 'silent', info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, trace: () => {}, child: () => null as any }),
      },
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('WhatsApp QR code generated — scan with your phone');
      }

      if (connection === 'open') {
        logger.info('WhatsApp connected');
        this.running = true;
        this.reconnectAttempts = 0;
      }

      if (connection === 'close') {
        this.running = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn({ statusCode, shouldReconnect }, 'WhatsApp disconnected');

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
          logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'WhatsApp reconnecting');
          setTimeout(() => this.connect(), delay);
        } else {
          logger.error('WhatsApp connection closed permanently');
        }
      }
    });

    this.sock.ev.on('messages.upsert', async (payload) => {
      const { messages, type } = payload;
      if (type !== 'notify') return;

      for (const msg of messages) {
        await this.handleMessage(msg);
      }
    });
  }

  private async handleMessage(msg: WAMessage): Promise<void> {
    // Skip if no message content or from self
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid!;
    const isGroup = jid.endsWith('@g.us');
    const senderId = isGroup ? (msg.key.participant || jid) : jid;
    const phone = (senderId as string).split('@')[0]!;

    // Allowlist checks
    if (!isGroup && this.config.allowedNumbers.length > 0 && !this.config.allowedNumbers.includes(phone)) {
      logger.warn({ phone }, 'Unauthorized WhatsApp number, ignoring');
      return;
    }

    if (isGroup && this.config.allowedGroups.length > 0 && !this.config.allowedGroups.includes(jid)) {
      logger.warn({ groupJid: jid }, 'Unauthorized WhatsApp group, ignoring');
      return;
    }

    // Extract text
    const text = this.extractText(msg);
    if (!text) return;

    // For groups, only respond to messages with the prefix or mentions
    if (isGroup && this.config.handleGroups) {
      const hasPrefix = text.startsWith(this.config.groupPrefix);
      const hasMention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length;
      const isQuoted = !!msg.message?.extendedTextMessage?.contextInfo?.stanzaId;

      if (!hasPrefix && !hasMention && !isQuoted) return;

      // Strip prefix if present
      const processedText = hasPrefix ? text.slice(this.config.groupPrefix.length).trim() : text;

      this.dispatchMessage(jid, senderId, processedText, {
        isGroup: true,
        groupJid: jid,
        phone,
      });
      return;
    }

    // DM
    if (!isGroup) {
      this.dispatchMessage(jid, senderId, text, {
        isGroup: false,
        phone,
      });
    }
  }

  private extractText(msg: WAMessage): string | null {
    const m = msg.message;
    if (!m) return null;

    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage) {
      const caption = m.imageMessage.caption || '';
      return caption ? `[image] ${caption}` : '[image]';
    }
    if (m.videoMessage) {
      const caption = m.videoMessage.caption || '';
      return caption ? `[video] ${caption}` : '[video]';
    }
    if (m.documentMessage) {
      return `[document: ${m.documentMessage.fileName || 'file'}]`;
    }
    if (m.audioMessage) return '[audio]';
    if (m.stickerMessage) return '[sticker]';
    if (m.contactMessage) return `[contact: ${m.contactMessage.displayName}]`;
    if (m.locationMessage) return `[location: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}]`;

    return null;
  }

  private dispatchMessage(
    jid: string,
    senderId: string,
    text: string,
    extraMeta: Record<string, unknown>,
  ): void {
    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: senderId,
      text,
      channelId: `whatsapp:${jid}`,
      metadata: {
        channelType: 'whatsapp',
        jid,
        senderId,
        ...extraMeta,
      },
      timestamp: Date.now(),
    };

    for (const h of this.handlers) h(envelope);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sock) {
      this.sock.end(new Error('Channel stopping'));
      this.sock = null;
    }
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.handlers.push(handler);
  }

  // ── Typing indicators ───────────────────────────────────────────

  async startTyping(chatId: string): Promise<void> {
    if (!this.sock) return;
    const jid = chatId.replace('whatsapp:', '');
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
    } catch { /* ignore */ }
  }

  stopTyping(chatId: string): void {
    if (!this.sock) return;
    const jid = chatId.replace('whatsapp:', '');
    this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
  }

  // ── Core send ───────────────────────────────────────────────────

  async send(envelope: MessageEnvelope, response: string): Promise<void> {
    if (!this.sock) {
      logger.error('WhatsApp socket not connected, cannot send');
      return;
    }

    const jid = ((envelope.metadata?.jid as string) || envelope.channelId?.replace('whatsapp:', ''));
    if (!jid) {
      logger.error({ envelope: envelope.id }, 'No JID in envelope');
      return;
    }

    try {
      const quotedId = envelope.metadata?.messageId as string | undefined;

      await this.sock.sendMessage(jid, {
        text: response,
        ...(quotedId ? {
          quoted: {
            key: {
              remoteJid: jid,
              id: quotedId,
              fromMe: false,
            },
            message: { conversation: envelope.text },
          },
        } : {}),
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, jid }, 'Failed to send WhatsApp message');
    }
  }

  // ── Send media ──────────────────────────────────────────────────

  async sendMedia(envelope: MessageEnvelope, media: MediaAttachment): Promise<void> {
    if (!this.sock) return;

    const jid = ((envelope.metadata?.jid as string) || envelope.channelId?.replace('whatsapp:', ''));
    if (!jid) return;

    try {
      const content: Record<string, unknown> = {
        caption: media.caption || undefined,
      };

      if (typeof media.data === 'string') {
        // URL or file path
        content[media.type === 'photo' ? 'image' : media.type === 'video' ? 'video' : 'document'] = { url: media.data };
        if (media.filename) content.fileName = media.filename;
        if (media.mimeType) content.mimetype = media.mimeType;
      } else {
        // Buffer
        const key = media.type === 'photo' ? 'image' : media.type === 'video' ? 'video' : 'document';
        content[key] = media.data;
        if (media.filename) content.fileName = media.filename;
        if (media.mimeType) content.mimetype = media.mimeType;
      }

      await this.sock.sendMessage(jid, content as any);
    } catch (err) {
      logger.error({ error: (err as Error).message, jid, type: media.type }, 'Failed to send WhatsApp media');
    }
  }
}
