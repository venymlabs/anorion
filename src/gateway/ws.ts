import { logger } from '../shared/logger';
import { eventBus, type EventName } from '../shared/events';

type WsClient = { send: (data: string) => void; addEventListener: (type: string, fn: (ev: any) => void) => void; readyState: number };
const clients = new Map<WsClient, Set<string>>();

const WS_OPEN = 1;

const AGENT_EVENTS: EventName[] = [
  'agent:processing',
  'agent:tool-call',
  'agent:response',
  'agent:error',
  'agent:idle',
];

export function handleWebSocket(ws: WsClient) {
  clients.set(ws, new Set());
  logger.info('WebSocket client connected');

  ws.addEventListener('message', (event: { data: string }) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      logger.debug({ msg }, 'WS message received');

      if (msg.type === 'subscribe') {
        const subs = clients.get(ws);
        if (subs) {
          const agents = msg.agents || [];
          for (const a of agents) subs.add(a);
        }
        ws.send(JSON.stringify({ type: 'subscribed', agents: msg.agents || [] }));
      }

      if (msg.type === 'unsubscribe') {
        const subs = clients.get(ws);
        if (subs) {
          for (const a of msg.agents || []) subs.delete(a);
        }
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.addEventListener('close', () => {
    clients.delete(ws);
    logger.info('WebSocket client disconnected');
  });
}

function broadcastEvent(eventName: string, data: any) {
  const payload = JSON.stringify({ type: eventName, ...data });
  for (const [ws, subs] of clients) {
    if ((ws as any).readyState !== WS_OPEN) continue;
    // If client subscribed to specific agents, filter; else send all
    if (subs.size > 0 && data.agentId && !subs.has(data.agentId)) continue;
    ws.send(payload);
  }
}

// Subscribe to all agent events from the event bus
for (const ev of AGENT_EVENTS) {
  eventBus.on(ev, (data: any) => broadcastEvent(ev, data));
}

/** Broadcast a raw message to all connected WebSocket clients */
export function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const ws of clients.keys()) {
    if ((ws as any).readyState === WS_OPEN) {
      ws.send(data);
    }
  }
}
