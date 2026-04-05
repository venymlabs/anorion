// Bridge Client — outbound connection to a peer gateway

import type {
  BridgeMessage,
  HelloPayload,
  MessageForwardPayload,
  MessageResponsePayload,
} from './protocol';
import {
  createBridgeMessage,
  parseBridgeMessage,
  BRIDGE_VERSION,
} from './protocol';
import { logger } from '../shared/logger';
import { agentRegistry } from '../agents/registry';

export type ClientState = 'disconnected' | 'connecting' | 'connected';

interface PendingRequest {
  resolve: (msg: BridgeMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient {
  readonly peerUrl: string;
  readonly secret: string;
  state: ClientState = 'disconnected';
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private queue: BridgeMessage[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private peerGatewayId: string | null = null;
  private onMessage: ((msg: BridgeMessage) => void) | null = null;
  private onClose: (() => void) | null = null;
  private stopped = false;

  constructor(peerUrl: string, secret: string) {
    this.peerUrl = peerUrl;
    this.secret = secret;
  }

  get connected(): boolean {
    return this.state === 'connected' && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  setHandlers(onMessage: (msg: BridgeMessage) => void, onClose: () => void) {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  async start(ownGatewayId: string): Promise<void> {
    this.stopped = false;
    this.connect(ownGatewayId);
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
    // Reject pending
    for (const [id, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('Client stopped'));
      this.pendingRequests.delete(id);
    }
  }

  send(msg: BridgeMessage): void {
    if (this.connected) {
      this.ws!.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  async request(msg: BridgeMessage, timeoutMs = 30000): Promise<BridgeMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.messageId);
        reject(new Error('Bridge request timeout'));
      }, timeoutMs);
      this.pendingRequests.set(msg.messageId, { resolve, reject, timer });
      this.send(msg);
    });
  }

  private connect(ownGatewayId: string): void {
    if (this.stopped) return;
    this.state = 'connecting';
    logger.info({ url: this.peerUrl, backoff: this.backoffMs }, 'Bridge client connecting');

    try {
      const url = new URL(this.peerUrl);
      url.searchParams.set('secret', this.secret);

      this.ws = new WebSocket(url.toString());
      this.ws.onopen = () => {
        this.state = 'connected';
        this.backoffMs = 1000;
        logger.info({ url: this.peerUrl }, 'Bridge client connected');

        // Send hello
        const hello = createBridgeMessage('hello', ownGatewayId, {
          secret: this.secret,
          gatewayId: ownGatewayId,
          agents: agentRegistry.list().map((a) => ({ id: a.id, name: a.name, status: a.state })),
        } as HelloPayload);
        this.ws!.send(JSON.stringify(hello));

        // Flush queue
        for (const msg of this.queue) {
          this.ws!.send(JSON.stringify(msg));
        }
        this.queue = [];

        // Start heartbeat
        this.heartbeatTimer = setInterval(() => {
          if (this.connected) {
            this.send(createBridgeMessage('health-ping', ownGatewayId, {}));
          }
        }, 30_000);
      };

      this.ws.onmessage = (event) => {
        const msg = parseBridgeMessage(event.data as string);
        if (!msg) return;

        // Handle pending requests
        const pending = this.pendingRequests.get(msg.messageId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.messageId);
          pending.resolve(msg);
          return;
        }

        if (msg.type === 'hello-ack') {
          this.peerGatewayId = msg.gatewayId;
          logger.info({ peerGatewayId: this.peerGatewayId }, 'Bridge peer acknowledged');
        }

        if (msg.type === 'message-forward') {
          // Handle incoming message-forward from peer (we are the target)
          void this.handleMessageForward(msg, ownGatewayId);
          return;
        }

        this.onMessage?.(msg);
      };

      this.ws.onclose = () => {
        logger.info({ url: this.peerUrl }, 'Bridge client disconnected');
        this.state = 'disconnected';
        this.onClose?.();
        this.scheduleReconnect(ownGatewayId);
      };

      this.ws.onerror = (err) => {
        logger.error({ url: this.peerUrl, error: String(err) }, 'Bridge client error');
      };
    } catch (err) {
      logger.error({ url: this.peerUrl, error: (err as Error).message }, 'Bridge client connect failed');
      this.scheduleReconnect(ownGatewayId);
    }
  }

  private async handleMessageForward(msg: BridgeMessage, ownGatewayId: string): Promise<void> {
    const payload = msg.payload as MessageForwardPayload;
    const { sendMessage } = await import('../agents/runtime');
    try {
      const result = await sendMessage({
        agentId: payload.targetAgentId,
        sessionId: payload.sessionId,
        text: payload.text,
        channelId: payload.channelId,
      });
      const response = createBridgeMessage('message-response', ownGatewayId, {
        requestMessageId: msg.messageId,
        content: result.content,
      } as MessageResponsePayload);
      this.send(response);
    } catch (err) {
      const response = createBridgeMessage('message-response', ownGatewayId, {
        requestMessageId: msg.messageId,
        content: '',
        error: (err as Error).message,
      } as MessageResponsePayload);
      this.send(response);
    }
  }

  private scheduleReconnect(ownGatewayId: string): void {
    if (this.stopped) return;
    this.cleanup();
    this.reconnectTimer = setTimeout(() => {
      this.connect(ownGatewayId);
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
