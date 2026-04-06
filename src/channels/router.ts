import type { MessageEnvelope, StreamingConfig } from '../shared/types';
import { DEFAULT_STREAMING_CONFIG } from '../shared/types';
import type { ChannelAdapter } from './base';
import { sendMessage, streamMessage } from '../agents/runtime';
import { pipeStreamToChannel } from '../streaming/buffer';
import { logger } from '../shared/logger';

interface RouteRule {
  channelType: string;
  channelId?: string;
  agentName: string;
  /** Override streaming for this route (true = always stream, false = never, undefined = use channel default) */
  streaming?: boolean;
}

interface RouterConfig {
  routes: RouteRule[];
  defaultAgent: string;
  streaming?: Partial<StreamingConfig>;
}

class ChannelRouter {
  private channels = new Map<string, ChannelAdapter>();
  private rules: RouteRule[] = [];
  private defaultAgent = 'example';
  private streamingConfig: StreamingConfig = { ...DEFAULT_STREAMING_CONFIG };

  configure(config: RouterConfig): void {
    this.rules = config.routes;
    this.defaultAgent = config.defaultAgent;
    if (config.streaming) {
      this.streamingConfig = { ...DEFAULT_STREAMING_CONFIG, ...config.streaming };
    }
    logger.info(
      { rules: this.rules.length, default: this.defaultAgent, streaming: this.streamingConfig.enabled },
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
    let routeStreaming: boolean | undefined;

    for (const rule of this.rules) {
      if (rule.channelType === channelType) {
        if (!rule.channelId || rule.channelId === envelope.channelId) {
          agentName = rule.agentName;
          routeStreaming = rule.streaming;
          break;
        }
      }
    }

    if (!agentName) {
      agentName = this.defaultAgent;
    }

    const useStreaming = routeStreaming !== undefined ? routeStreaming : this.streamingConfig.enabled;
    const channelSupportsStreaming = !!channel.startStreaming && !!channel.editStreamingMessage && !!channel.finishStreaming;

    logger.info(
      {
        envelope: envelope.id,
        from: envelope.from,
        channel: channelType,
        agent: agentName,
        streaming: useStreaming && channelSupportsStreaming,
      },
      'Routing message',
    );

    try {
      if (useStreaming && channelSupportsStreaming) {
        // Streaming path — pipe tokens through StreamingBuffer to channel
        const gen = streamMessage({
          agentId: agentName,
          text: envelope.text,
          channelId: envelope.channelId,
        });

        await pipeStreamToChannel(gen, channel, envelope, this.streamingConfig);
      } else {
        // Buffered path — wait for full response then send
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
      }
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
