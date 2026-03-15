// Bridge wire protocol for gateway-to-gateway communication

export const BRIDGE_VERSION = '1.0.0';

export type BridgeMessageType =
  | 'hello'
  | 'agent-register'
  | 'agent-update'
  | 'message-forward'
  | 'message-response'
  | 'health-ping'
  | 'health-pong'
  | 'unsubscribe'
  | 'hello-ack';

export interface BridgeMessage {
  version: string;
  type: BridgeMessageType;
  messageId: string;
  gatewayId: string;
  timestamp: number;
  payload: unknown;
}

// Payloads

export interface HelloPayload {
  secret: string;
  gatewayId: string;
  agents: { id: string; name: string; status: string }[];
  capabilities?: string[];
}

export interface HelloAckPayload {
  gatewayId: string;
  agents: { id: string; name: string; status: string }[];
}

export interface AgentRegisterPayload {
  agents: { id: string; name: string; status: string }[];
}

export interface AgentUpdatePayload {
  agentId: string;
  status: string;
}

export interface MessageForwardPayload {
  targetAgentId: string;
  messageId: string;
  sessionId?: string;
  text: string;
  channelId?: string;
}

export interface MessageResponsePayload {
  requestMessageId: string;
  content: string;
  error?: string;
}

export function createBridgeMessage(
  type: BridgeMessageType,
  gatewayId: string,
  payload: unknown,
  messageId?: string,
): BridgeMessage {
  return {
    version: BRIDGE_VERSION,
    type,
    messageId: messageId || crypto.randomUUID(),
    gatewayId,
    timestamp: Date.now(),
    payload,
  };
}

export function parseBridgeMessage(data: string): BridgeMessage | null {
  try {
    const msg = JSON.parse(data);
    if (msg.version && msg.type && msg.messageId && msg.gatewayId && msg.timestamp !== undefined) {
      return msg as BridgeMessage;
    }
    return null;
  } catch {
    return null;
  }
}
