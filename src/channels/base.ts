import type { MessageEnvelope } from '../shared/types';

export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (envelope: MessageEnvelope) => void): void;
  send(envelope: MessageEnvelope, response: string): Promise<void>;
}
