import type { MessageEnvelope } from '../shared/types';
import type { ChannelAdapter } from './base';
import { sendMessage } from '../agents/runtime';
import { logger } from '../shared/logger';

interface RouteRule {
  channelType: string;
  channelId?: string;
  agentName: string;
}

interface RouterConfig {
  routes: RouteRule[];
  defaultAgent: string;
}

class ChannelRouter {
  private channels = new Map<string, ChannelAdapter>();
  private rules: RouteRule[] = [];
  private defaultAgent = 'example';

  configure(config: RouterConfig): void {
    this.rules = config.routes;
    this.defaultAgent = config.defaultAgent;
    logger.info(
      { rules: this.rules.length, default: this.defaultAgent },
      'Channel router configured',
    );
  }

  registerChannel(channel: ChannelAdapter): void {
    this.channels.set(channel.name, channel);
    logger.info({ channel: channel.name }, 'Channel registered');

    channel.onMessage((envelope) => {
      this.routeMessage(channel, envelope).catch((err) => {
        logger.error({ error: (err as Error).message, envelope: envelope.id }, 'Route error');
      });
    });
  }

  private async routeMessage(channel: ChannelAdapter, envelope: MessageEnvelope): Promise<void> {
    const channelType = (envelope.metadata?.channelType as string) || channel.name;

    // Find matching route
    let agentName: string | undefined;

    for (const rule of this.rules) {
      if (rule.channelType === channelType) {
        if (!rule.channelId || rule.channelId === envelope.channelId) {
          agentName = rule.agentName;
          break;
        }
      }
    }

    if (!agentName) {
      agentName = this.defaultAgent;
    }

    logger.info(
      {
        envelope: envelope.id,
        from: envelope.from,
        channel: channelType,
        agent: agentName,
      },
      'Routing message',
    );

    try {
      const result = await sendMessage({
        agentId: agentName,
        text: envelope.text,
        channelId: envelope.channelId,
      });

      const reply = result.content || 'I processed your request but had no text response to share.';
      if (!result.content) {
        logger.warn({ agent: agentName, sessionId: result.sessionId }, 'Agent returned empty content, sending fallback');
      }
      await channel.send(envelope, reply);
    } catch (err) {
      const errorMsg = `Error: ${(err as Error).message}`;
      logger.error({ error: errorMsg, agent: agentName }, 'Agent processing failed');
      await channel.send(envelope, errorMsg);
    }
  }

  getChannel(name: string): ChannelAdapter | undefined {
    return this.channels.get(name);
  }

  listChannels(): { name: string; running: boolean }[] {
    return [...this.channels.keys()].map((name) => ({
      name,
      running: true,
    }));
  }

  async startChannel(name: string): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;
    await channel.start();
    return true;
  }

  async stopChannel(name: string): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;
    await channel.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
  }
}

export const channelRouter = new ChannelRouter();
