// Bridge Server — inbound WebSocket acceptor on /bridge path

import type {
  BridgeMessage,
  HelloPayload,
  MessageForwardPayload,
  MessageResponsePayload,
} from './protocol';
import {
  createBridgeMessage,
  parseBridgeMessage,
} from './protocol';
import { logger } from '../shared/logger';
import { agentRegistry } from '../agents/registry';

interface BridgeConnection {
  gatewayId: string;
  ws: { send: (data: string) => void; addEventListener: (type: string, fn: (ev: any) => void) => void; close: (code?: number, reason?: string) => void; readyState?: number };
  connectedAt: number;
  lastPong: number;
  agents: { id: string; name: string; status: string }[];
}

export class BridgeServer {
  private connections = new Map<string, BridgeConnection>(); // gatewayId -> conn
  private secret: string;
  private ownGatewayId: string;
  private pongTimeoutMs = 60_000;
  private pendingResponses = new Map<string, (msg: BridgeMessage) => void>();

  constructor(ownGatewayId: string, secret: string) {
    this.ownGatewayId = ownGatewayId;
    this.secret = secret;

    // Health check: disconnect stale peers
    setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.connections) {
        if (now - conn.lastPong > this.pongTimeoutMs) {
          logger.warn({ peerId: id }, 'Bridge peer health check failed, disconnecting');
          conn.ws.close(4008, 'Health check timeout');
          this.connections.delete(id);
        }
      }
    }, 30_000);
  }

  /** Handle an upgraded WebSocket connection for /bridge (called from Bun.serve websocket handlers) */
  handleConnection(ws: { send: (data: string) => void; addEventListener: (type: string, fn: (ev: any) => void) => void; close: (code?: number, reason?: string) => void }, secret?: string): boolean {
    if (secret !== this.secret) {
      logger.warn('Bridge connection rejected: invalid secret');
      ws.close(4001, 'Unauthorized');
      return false;
    }

    const conn: BridgeConnection = {
      gatewayId: '',
      ws,
      connectedAt: Date.now(),
      lastPong: Date.now(),
      agents: [],
    };

    ws.addEventListener('message', (event) => {
      const msg = parseBridgeMessage(event.data as string);
      if (!msg) {
        ws.send(JSON.stringify({ error: 'Invalid message' }));
        return;
      }
      void this.handleMessage(conn, msg);
    });

    ws.addEventListener('close', () => {
      if (conn.gatewayId) {
        this.connections.delete(conn.gatewayId);
        logger.info({ peerId: conn.gatewayId }, 'Bridge peer disconnected');
      }
    });

    return true;
  }

  /** Legacy attach — no-op for Bun.serve(), use handleConnection instead */
  attach(_server: unknown): void {
    logger.info('Bridge server ready on /bridge (via Bun.serve)');
  }

  private async handleMessage(conn: BridgeConnection, msg: BridgeMessage): Promise<void> {
    switch (msg.type) {
      case 'hello': {
        const payload = msg.payload as HelloPayload;
        conn.gatewayId = msg.gatewayId;
        conn.agents = payload.agents || [];
        conn.lastPong = Date.now();
        this.connections.set(msg.gatewayId, conn);

        logger.info({ peerId: msg.gatewayId, agentCount: conn.agents.length }, 'Bridge peer registered');

        // Send hello-ack
        const ack = createBridgeMessage('hello-ack', this.ownGatewayId, {
          gatewayId: this.ownGatewayId,
          agents: agentRegistry.list().map((a) => ({ id: a.id, name: a.name, status: a.state })),
        });
        conn.ws.send(JSON.stringify(ack));
        break;
      }

      case 'agent-register':
      case 'agent-update': {
        conn.lastPong = Date.now();
        // Update peer's agent list
        if (msg.type === 'agent-register') {
          conn.agents = (msg.payload as { agents: BridgeConnection['agents'] }).agents || [];
        }
        break;
      }

      case 'message-forward': {
        conn.lastPong = Date.now();
        await this.handleMessageForward(conn, msg);
        break;
      }

      case 'message-response': {
        conn.lastPong = Date.now();
        const payload = msg.payload as MessageResponsePayload;
        const handler = this.pendingResponses.get(payload.requestMessageId);
        if (handler) {
          handler(msg);
          this.pendingResponses.delete(payload.requestMessageId);
        }
        break;
      }

      case 'health-ping': {
        conn.lastPong = Date.now();
        conn.ws.send(JSON.stringify(createBridgeMessage('health-pong', this.ownGatewayId, {})));
        break;
      }

      case 'health-pong': {
        conn.lastPong = Date.now();
        break;
      }

      case 'unsubscribe': {
        this.connections.delete(conn.gatewayId);
        conn.ws.close();
        break;
      }
    }
  }

  private async handleMessageForward(conn: BridgeConnection, msg: BridgeMessage): Promise<void> {
    const payload = msg.payload as MessageForwardPayload;
    const { sendMessage } = await import('../agents/runtime');

    try {
      const result = await sendMessage({
        agentId: payload.targetAgentId,
        sessionId: payload.sessionId,
        text: payload.text,
        channelId: payload.channelId,
      });
      const response = createBridgeMessage('message-response', this.ownGatewayId, {
        requestMessageId: msg.messageId,
        content: result.content,
      } as MessageResponsePayload);
      conn.ws.send(JSON.stringify(response));
    } catch (err) {
      const response = createBridgeMessage('message-response', this.ownGatewayId, {
        requestMessageId: msg.messageId,
        content: '',
        error: (err as Error).message,
      } as MessageResponsePayload);
      conn.ws.send(JSON.stringify(response));
    }
  }

  // Send a message to a specific peer gateway and wait for response
  async sendToPeer(
    gatewayId: string,
    msg: BridgeMessage,
    timeoutMs = 30_000,
  ): Promise<BridgeMessage> {
    const conn = this.connections.get(gatewayId);
    if (!conn || (conn.ws as any).readyState !== 1) {
      throw new Error(`Peer not connected: ${gatewayId}`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(msg.messageId);
        reject(new Error('Bridge request timeout'));
      }, timeoutMs);
      this.pendingResponses.set(msg.messageId, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      conn.ws.send(JSON.stringify(msg));
    });
  }

  // Broadcast agent update to all connected peers
  broadcastAgentUpdate(agentId: string, status: string): void {
    const msg = createBridgeMessage('agent-update', this.ownGatewayId, { agentId, status });
    for (const [, conn] of this.connections) {
      if ((conn.ws as any).readyState === 1) {
        conn.ws.send(JSON.stringify(msg));
      }
    }
  }

  getConnections(): Map<string, BridgeConnection> {
    return this.connections;
  }

  getConnection(gatewayId: string): BridgeConnection | undefined {
    return this.connections.get(gatewayId);
  }
}
