// Federator — peer table management, agent discovery, message routing

import { createBridgeMessage, type MessageForwardPayload, type MessageResponsePayload } from './protocol';
import { BridgeClient } from './client';
import { BridgeServer } from './server';
import { agentRegistry } from '../agents/registry';
import { logger } from '../shared/logger';

export interface PeerInfo {
  id: string;
  url: string;
  status: 'connecting' | 'connected' | 'disconnected';
  agentCount: number;
  connectedAt?: number;
  lastPing: number;
}

interface RemoteAgent {
  id: string;
  name: string;
  status: string;
  gatewayId: string;
}

export class Federator {
  private ownGatewayId: string;
  private secret: string;
  private clients = new Map<string, BridgeClient>(); // url -> client
  private bridgeServer: BridgeServer;
  private messageQueue: Array<{ targetAgentId: string; payload: MessageForwardPayload; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  private stats = { messagesForwarded: 0, messagesReceived: 0, startTime: Date.now() };

  constructor(ownGatewayId: string, secret: string, bridgeServer: BridgeServer) {
    this.ownGatewayId = ownGatewayId;
    this.secret = secret;
    this.bridgeServer = bridgeServer;
  }

  async connectPeer(url: string, secret: string): Promise<void> {
    if (this.clients.has(url)) {
      logger.warn({ url }, 'Peer already configured');
      return;
    }

    const client = new BridgeClient(url, secret);

    client.setHandlers(
      (msg) => this.handleClientMessage(url, msg),
      () => logger.info({ url }, 'Bridge client closed'),
    );

    this.clients.set(url, client);
    await client.start(this.ownGatewayId);
  }

  disconnectPeer(url: string): void {
    const client = this.clients.get(url);
    if (client) {
      client.stop();
      this.clients.delete(url);
    }
  }

  private handleClientMessage(_url: string, _msg: unknown): void {
    // Client-level messages handled internally (hello-ack etc.)
  }

  // Get all agents: local + remote
  getAllAgents(): { local: ReturnType<typeof agentRegistry.list>; remote: RemoteAgent[] } {
    const local = agentRegistry.list();
    const remote: RemoteAgent[] = [];

    // From server-side connections
    for (const [, conn] of this.bridgeServer.getConnections()) {
      for (const agent of conn.agents) {
        remote.push({ ...agent, gatewayId: conn.gatewayId });
      }
    }

    return { local, remote };
  }

  // Check if an agent is remote (hosted on a peer)
  findRemoteAgent(agentId: string): { gatewayId: string; gatewayUrl?: string } | null {
    // Check server-side connections (inbound)
    for (const [gwId, conn] of this.bridgeServer.getConnections()) {
      if (conn.agents.some((a) => a.id === agentId)) {
        return { gatewayId: gwId };
      }
    }
    return null;
  }

  // Route a message to an agent (local or remote)
  async routeMessage(targetAgentId: string, text: string, sessionId?: string, channelId?: string): Promise<{ content: string; error?: string }> {
    // Check local first
    const local = agentRegistry.get(targetAgentId) || agentRegistry.getByName(targetAgentId);
    if (local) {
      const { sendMessage } = await import('../agents/runtime');
      const result = await sendMessage({ agentId: local.id, sessionId, text, channelId });
      return { content: result.content };
    }

    // Check remote
    const remote = this.findRemoteAgent(targetAgentId);
    if (remote) {
      return this.sendToRemote(remote.gatewayId, targetAgentId, text, sessionId, channelId);
    }

    // Check remote by name too
    const { remote: allRemote } = this.getAllAgents();
    const namedRemote = allRemote.find((a) => a.name === targetAgentId);
    if (namedRemote) {
      return this.sendToRemote(namedRemote.gatewayId, namedRemote.id, text, sessionId, channelId);
    }

    // Queue if not found (maybe agent will appear)
    return new Promise((resolve, reject) => {
      this.messageQueue.push({ targetAgentId, payload: { targetAgentId, text, sessionId, channelId }, resolve, reject });
      // Auto-reject after 30s
      setTimeout(() => {
        const idx = this.messageQueue.findIndex((m) => m.resolve === resolve);
        if (idx !== -1) {
          this.messageQueue.splice(idx, 1);
          reject(new Error(`Agent not found: ${targetAgentId}`));
        }
      }, 30_000);
    });
  }

  private async sendToRemote(gatewayId: string, targetAgentId: string, text: string, sessionId?: string, channelId?: string): Promise<{ content: string; error?: string }> {
    const msg = createBridgeMessage('message-forward', this.ownGatewayId, {
      targetAgentId,
      sessionId,
      text,
      channelId,
    } as MessageForwardPayload);

    this.stats.messagesForwarded++;

    try {
      const response = await this.bridgeServer.sendToPeer(gatewayId, msg);
      const payload = response.payload as MessageResponsePayload;
      this.stats.messagesReceived++;
      return { content: payload.content, error: payload.error };
    } catch (err) {
      return { content: '', error: (err as Error).message };
    }
  }

  // Process queued messages if agents become available
  flushQueue(): void {
    const remaining = [];
    for (const item of this.messageQueue) {
      const local = agentRegistry.get(item.targetAgentId);
      const remote = this.findRemoteAgent(item.targetAgentId);
      if (local || remote) {
        this.routeMessage(item.targetAgentId, item.payload.text, item.payload.sessionId, item.payload.channelId)
          .then(item.resolve)
          .catch(item.reject);
      } else {
        remaining.push(item);
      }
    }
    this.messageQueue = remaining;
  }

  // Peer status for API
  getPeers(): PeerInfo[] {
    const peers: PeerInfo[] = [];

    // Outbound clients
    for (const [url, client] of this.clients) {
      const gwId = 'outbound-' + url.replace(/[^a-zA-Z0-9]/g, '-');
      peers.push({
        id: gwId,
        url,
        status: client.state,
        agentCount: 0,
        lastPing: Date.now(),
      });
    }

    // Inbound connections
    for (const [gwId, conn] of this.bridgeServer.getConnections()) {
      peers.push({
        id: gwId,
        url: 'inbound',
        status: 'connected',
        agentCount: conn.agents.length,
        connectedAt: conn.connectedAt,
        lastPing: conn.lastPong,
      });
    }

    return peers;
  }

  getStatus() {
    return {
      enabled: true,
      peerCount: this.clients.size + this.bridgeServer.getConnections().size,
      messagesForwarded: this.stats.messagesForwarded,
      messagesReceived: this.stats.messagesReceived,
      uptime: Date.now() - this.stats.startTime,
    };
  }
}
