// Webhook Channel — generic inbound/outbound adapter for Slack, Teams, custom apps

import type { ChannelAdapter } from './base';
import type { MessageEnvelope } from '../shared/types';
import { logger } from '../shared/logger';
import { nanoid } from 'nanoid';
import { eventBus } from '../shared/events';

interface WebhookConfig {
  /** Secret for verifying inbound webhooks (HMAC-SHA256) */
  inboundSecret: string;
  /** Outbound webhook URLs to POST responses to */
  outboundUrls: string[];
  /** Allowed source IPs (empty = allow all) */
  allowedIps: string[];
}

interface WebhookResponse {
  id: string;
  envelopeId: string;
  content: string;
  timestamp: number;
}

export class WebhookChannel implements ChannelAdapter {
  name = 'webhook';
  private config: WebhookConfig;
  private handlers: ((envelope: MessageEnvelope) => void)[] = [];
  private running = false;

  constructor(config: Partial<WebhookConfig> & { inboundSecret: string }) {
    this.config = {
      inboundSecret: config.inboundSecret,
      outboundUrls: config.outboundUrls || [],
      allowedIps: config.allowedIps || [],
    };
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info({ outboundCount: this.config.outboundUrls.length }, 'Webhook channel started');
  }

  async stop(): Promise<void> {
    this.running = false;
    logger.info('Webhook channel stopped');
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): void {
    this.handlers.push(handler);
  }

  async send(envelope: MessageEnvelope, response: string): Promise<void> {
    const payload: WebhookResponse = {
      id: nanoid(12),
      envelopeId: envelope.id,
      content: response,
      timestamp: Date.now(),
    };

    // POST to all outbound URLs
    const results = await Promise.allSettled(
      this.config.outboundUrls.map(async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Anorion-Webhook-Id': payload.id,
            'X-Anorion-Signature': await this.sign(JSON.stringify(payload)),
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw new Error(`Webhook delivery failed: ${res.status} ${res.statusText}`);
        }
        return res;
      }),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      logger.error({
        envelope: envelope.id,
        failed: failures.length,
        total: results.length,
      }, 'Some webhook deliveries failed');
    }
  }

  /** Handle an inbound webhook request (called from the gateway HTTP handler) */
  handleInbound(body: {
    text: string;
    from?: string;
    channelId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }, sourceIp?: string): { accepted: boolean; error?: string } {
    if (!this.running) return { accepted: false, error: 'Webhook channel not running' };

    // IP allowlist
    if (this.config.allowedIps.length > 0 && sourceIp && !this.config.allowedIps.includes(sourceIp)) {
      return { accepted: false, error: 'IP not allowed' };
    }

    if (!body.text) return { accepted: false, error: 'text is required' };

    const envelope: MessageEnvelope = {
      id: nanoid(12),
      from: body.from || 'webhook',
      text: body.text,
      channelId: body.channelId || 'webhook',
      sessionId: body.sessionId,
      metadata: {
        channelType: 'webhook',
        ...body.metadata,
      },
      timestamp: Date.now(),
    };

    for (const handler of this.handlers) {
      handler(envelope);
    }

    return { accepted: true };
  }

  /** Verify inbound webhook signature */
  async verifySignature(payload: string, signature: string): Promise<boolean> {
    const expected = await this.sign(payload);
    return signature === expected;
  }

  /** Sign a payload with HMAC-SHA256 */
  private async sign(payload: string): Promise<string> {
    const key = new TextEncoder().encode(this.config.inboundSecret);
    const data = new TextEncoder().encode(payload);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
