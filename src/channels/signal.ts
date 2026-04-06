// Signal Channel — text, attachments via signal-cli REST API

import type { ChannelAdapter, MediaAttachment } from './base';
import type { MessageEnvelope } from '../shared/types';
import { logger } from '../shared/logger';
import { nanoid } from 'nanoid';
import { readFile, writeFile, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { promisify } from 'util';

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);

interface SignalConfig {
  /** Base URL for signal-cli REST API */
  apiUrl: string;
  /** Phone number registered with signal-cli (with country code) */
  phoneNumber: string;
  /** Signal numbers allowed to interact */
  allowedNumbers: string[];
  /** Allowed group IDs */
  allowedGroups: string[];
  defaultAgent: string;
  /** Polling interval in ms for checking messages */
  pollIntervalMs: number;
  /** Whether to handle group messages */
  handleGroups: boolean;
  /** Bot prefix for group commands */
  groupPrefix: string;
  /** Attachment tmp directory */
  attachmentDir: string;
}

interface SignalMessage {
  envelope: {
    source: string;
    sourceNumber: string;
    sourceName: string;
    sourceUuid: string;
    timestamp: number;
    dataMessage?: {
      timestamp: number;
      message?: string;
      groupInfo?: {
        groupId: string;
        groupName?: string;
        type?: string;
      };
      quote?: {
        id: number;
        author: string;
        text: string;
      };
      attachments?: SignalAttachment[];
      sticker?: {
        packId: string;
        packKey: string;
        stickerId: number;
      };
    };
    syncMessage?: {
      sentMessage?: {
        destination?: string;
        timestamp: number;
        message?: string;
      };
    };
  };
}

interface SignalAttachment {
  contentType: string;
  filename: string;
  id: string;
  size: number;
}

export class SignalChannel implements ChannelAdapter {
  name = 'signal';
  private config: SignalConfig;
  private handlers: ((envelope: MessageEnvelope) => void)[] = [];
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTimestamp = 0;

  constructor(config: Partial<SignalConfig>) {
    this.config = {
      apiUrl: config.apiUrl ?? 'http://localhost:8080',
      phoneNumber: config.phoneNumber ?? '',
      allowedNumbers: config.allowedNumbers ?? [],
      allowedGroups: config.allowedGroups ?? [],
      defaultAgent: config.defaultAgent ?? 'example',
      pollIntervalMs: config.pollIntervalMs ?? 3000,
      handleGroups: config.handleGroups ?? true,
      groupPrefix: config.groupPrefix ?? '!',
      attachmentDir: config.attachmentDir ?? './data/signal-attachments',
    };
  }

  async start(): Promise<void> {
    if (!this.config.phoneNumber) {
      logger.warn('Signal phone number not configured, skipping');
      return;
    }

    // Ensure attachment dir exists
    if (!existsSync(this.config.attachmentDir)) {
      mkdirSync(this.config.attachmentDir, { recursive: true });
    }

    // Verify signal-cli is reachable
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/about`);
      if (!res.ok) {
        throw new Error(`signal-cli returned ${res.status}`);
      }
      logger.info({ apiUrl: this.config.apiUrl }, 'Signal CLI REST API reachable');
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Cannot reach signal-cli REST API — is it running?');
      throw err;
    }

    this.running = true;
    this.lastTimestamp = Date.now();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        logger.error({ error: (err as Error).message }, 'Signal poll error');
      });
    }, this.config.pollIntervalMs);

    logger.info({ phone: this.config.phoneNumber }, 'Signal channel started (polling)');
  }

  private async pollMessages(): Promise<void> {
    if (!this.running) return;

    const url = `${this.config.apiUrl}/v1/receive/${this.config.phoneNumber}?timeout=0`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;

      const messages: SignalMessage[] = await res.json() as SignalMessage[];

      for (const msg of messages) {
        await this.handleRawMessage(msg);
      }
    } catch {
      // Ignore poll errors — will retry next interval
    }
  }

  private async handleRawMessage(msg: SignalMessage): Promise<void> {
    const data = msg.envelope.dataMessage;
    if (!data) return;

    const source = msg.envelope.sourceNumber;
    const timestamp = data.timestamp;

    // Skip old messages
    if (timestamp <= this.lastTimestamp) return;
    this.lastTimestamp = timestamp;

    const isGroup = !!data.groupInfo;
    const groupId = data.groupInfo?.groupId;
    const groupName = data.groupInfo?.groupName;

    // Allowlist checks
    if (this.config.allowedNumbers.length > 0 && !this.config.allowedNumbers.includes(source)) {
      logger.warn({ source }, 'Unauthorized Signal number, ignoring');
      return;
    }

    if (isGroup && this.config.allowedGroups.length > 0 && groupId && !this.config.allowedGroups.includes(groupId)) {
      logger.warn({ groupId }, 'Unauthorized Signal group, ignoring');
      return;
    }

    // Extract text
    let text = data.message || '';
    if (!text && data.attachments && data.attachments.length > 0) {
      text = `[attachment: ${data.attachments.map((a) => a.filename || a.contentType).join(', ')}]`;
    }

    if (!text) return;

    // Group prefix check
    if (isGroup && this.config.handleGroups) {
      const hasPrefix = text.startsWith(this.config.groupPrefix);
      if (!hasPrefix) return;
      text = text.slice(this.config.groupPrefix.length).trim();
    }

    // Download attachments
    const attachmentMeta: Record<string, unknown>[] = [];
    if (data.attachments) {
      for (const att of data.attachments) {
        const localPath = await this.downloadAttachment(att.id, att.filename);
        attachmentMeta.push({
          contentType: att.contentType,
          filename: att.filename,
          size: att.size,
          localPath,
        });
      }
    }

    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: source,
      text,
      channelId: isGroup ? `signal:group:${groupId}` : `signal:${source}`,
      metadata: {
        channelType: 'signal',
        sourceNumber: source,
        sourceName: msg.envelope.sourceName,
        isGroup,
        groupId,
        groupName,
        timestamp,
        hasQuote: !!data.quote,
        quoteText: data.quote?.text,
        hasAttachments: attachmentMeta.length > 0,
        attachments: attachmentMeta,
      },
      timestamp,
    };

    for (const h of this.handlers) h(envelope);
  }

  private async downloadAttachment(attachmentId: string, filename: string): Promise<string | null> {
    try {
      const url = `${this.config.apiUrl}/v1/attachments/${attachmentId}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      const localPath = join(this.config.attachmentDir, `${attachmentId}_${filename || 'file'}`);
      await writeFileAsync(localPath, Buffer.from(buffer));
      return localPath;
    } catch (err) {
      logger.error({ error: (err as Error).message, attachmentId }, 'Failed to download Signal attachment');
      return null;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.handlers.push(handler);
  }

  // ── Core send ───────────────────────────────────────────────────

  async send(envelope: MessageEnvelope, response: string): Promise<void> {
    if (!this.running) {
      logger.error('Signal channel not running, cannot send');
      return;
    }

    const { target, isGroup } = this.resolveTarget(envelope);
    if (!target) {
      logger.error({ envelope: envelope.id }, 'No target in Signal envelope');
      return;
    }

    try {
      if (isGroup) {
        await this.sendGroupMessage(target, response);
      } else {
        await this.sendDirectMessage(target, response);
      }
    } catch (err) {
      logger.error({ error: (err as Error).message, target }, 'Failed to send Signal message');
    }
  }

  private resolveTarget(envelope: MessageEnvelope): { target: string | null; isGroup: boolean } {
    const channelId = envelope.channelId || '';
    const metadata = envelope.metadata || {};

    // Group message
    const groupId = metadata.groupId as string | undefined;
    if (groupId || channelId.startsWith('signal:group:')) {
      return {
        target: groupId || channelId.replace('signal:group:', ''),
        isGroup: true,
      };
    }

    // Direct message
    const source = (metadata.sourceNumber as string) || channelId.replace('signal:', '');
    return { target: source, isGroup: false };
  }

  private async sendDirectMessage(number: string, text: string): Promise<void> {
    const url = `${this.config.apiUrl}/v2/send`;
    const body = {
      message: text,
      number: this.config.phoneNumber,
      recipients: [number],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Signal send failed: ${res.status} ${errorText}`);
    }
  }

  private async sendGroupMessage(groupId: string, text: string): Promise<void> {
    const url = `${this.config.apiUrl}/v2/send`;
    const body = {
      message: text,
      number: this.config.phoneNumber,
      recipients: [],
      group: groupId,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Signal group send failed: ${res.status} ${errorText}`);
    }
  }

  // ── Send media ──────────────────────────────────────────────────

  async sendMedia(envelope: MessageEnvelope, media: MediaAttachment): Promise<void> {
    if (!this.running) return;

    const { target, isGroup } = this.resolveTarget(envelope);
    if (!target) return;

    try {
      // signal-cli expects base64-encoded attachments
      let base64Data: string;
      if (typeof media.data === 'string') {
        // Treat as file path
        const fileBuffer = await readFileAsync(media.data);
        base64Data = fileBuffer.toString('base64');
      } else {
        base64Data = Buffer.from(media.data).toString('base64');
      }

      const url = `${this.config.apiUrl}/v2/send`;
      const body: Record<string, unknown> = {
        message: media.caption || '',
        number: this.config.phoneNumber,
        base64_attachments: [base64Data],
        attachment_filenames: [media.filename || 'file'],
        attachment_content_types: [media.mimeType || 'application/octet-stream'],
      };

      if (isGroup) {
        body.recipients = [];
        body.group = target;
      } else {
        body.recipients = [target];
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Signal media send failed: ${res.status} ${errorText}`);
      }
    } catch (err) {
      logger.error({ error: (err as Error).message, target, type: media.type }, 'Failed to send Signal media');
    }
  }
}
