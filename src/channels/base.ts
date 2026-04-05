import type { MessageEnvelope } from '../shared/types';

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface InlineKeyboard {
  buttons: InlineKeyboardButton[][];
}

export interface MediaAttachment {
  type: 'photo' | 'document' | 'voice' | 'video';
  data: Buffer | string; // Buffer or URL/file path
  filename?: string;
  caption?: string;
  mimeType?: string;
}

export interface StreamChunk {
  text: string;
  done: boolean;
}

export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (envelope: MessageEnvelope) => void): void;
  send(envelope: MessageEnvelope, response: string): Promise<void>;
  sendMedia?(envelope: MessageEnvelope, media: MediaAttachment): Promise<void>;
  sendWithKeyboard?(
    envelope: MessageEnvelope,
    response: string,
    keyboard: InlineKeyboard,
  ): Promise<void>;
  startTyping?(chatId: string): Promise<void>;
  stopTyping?(chatId: string): void;
  startStreaming?(envelope: MessageEnvelope, initialText?: string): Promise<string>;
  editStreamingMessage?(messageId: string, text: string): Promise<void>;
  finishStreaming?(messageId: string, finalText: string): Promise<void>;
}
