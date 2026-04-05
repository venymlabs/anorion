import { logger } from '../shared/logger';
import { eventBus, type EventName } from '../shared/events';

type WsClient = { send: (data: string) => void; addEventListener: (type: string, fn: (ev: any) => void) => void; readyState: number };
const clients = new Map<WsClient, { subs: Set<string>; authenticated: boolean; lastPing: number }>();

const WS_OPEN = 1;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// Configurable auth
let wsAuthToken: string | null = null;
let wsApiKeys: Map<string, string[]> | null = null;

export function setWsAuth(token: string | null, apiKeys: Map<string, string[]> | null) {
  wsAuthToken = token;
  wsApiKeys = apiKeys;
}

// Extended events to broadcast
const AGENT_EVENTS: EventName[] = [
  'agent:processing',
  'agent:tool-call',
  'agent:response',
  'agent:error',
  'agent:idle',
];

const SESSION_EVENTS: EventName[] = [
  'session:created',
  'session:destroyed',
  'session:idle',
];

const TRACE_EVENTS: EventName[] = [
  'tool:executed',
  'token:usage',
];

const ALL_BROADCAST_EVENTS = [...AGENT_EVENTS, ...SESSION_EVENTS, ...TRACE_EVENTS];

// Heartbeat checker
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [ws, state] of clients) {
      if (ws.readyState !== WS_OPEN) continue;

      // Check pong timeout
      if (state.lastPing && now - state.lastPing > PONG_TIMEOUT_MS) {
        logger.info('WS client pong timeout, disconnecting');
        try { (ws as any).close?.(); } catch { /* */ }
        clients.delete(ws);
        continue;
      }

      // Send ping
      state.lastPing = now;
      try {
        ws.send(JSON.stringify({ type: 'ping', timestamp: now }));
      } catch {
        clients.delete(ws);
      }
    }
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function isAuthenticated(state: { authenticated: boolean } | undefined): boolean {
  // If no auth is configured, everyone is authenticated
  if (!wsAuthToken && (!wsApiKeys || wsApiKeys.size === 0)) return true;
  return !!state?.authenticated;
}

export function handleWebSocket(ws: WsClient) {
  clients.set(ws, { subs: new Set(), authenticated: false, lastPing: 0 });
  startHeartbeat();
  logger.info('WebSocket client connected');

  ws.addEventListener('message', (event: { data: string }) => {
    const clientState = clients.get(ws);
    if (!clientState) return;

    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      logger.debug({ msg }, 'WS message received');

      // Handle pong
      if (msg.type === 'pong') {
        clientState.lastPing = 0;
        return;
      }

      // Handle authentication — can come as first message or via query param
      if (msg.type === 'auth') {
        const token = msg.token || msg.apiKey || '';
        const authenticated = authenticateWs(token);
        clientState.authenticated = authenticated;
        ws.send(JSON.stringify({ type: authenticated ? 'auth:ok' : 'auth:error', message: authenticated ? 'Authenticated' : 'Invalid credentials' }));
        if (!authenticated) {
          logger.warn('WS client authentication failed');
        }
        return;
      }

      // Require auth for all other messages if auth is configured
      if (!isAuthenticated(clientState)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
        return;
      }

      if (msg.type === 'subscribe') {
        const events = msg.events || [];
        const agents = msg.agents || [];
        for (const e of events) clientState.subs.add(`event:${e}`);
        for (const a of agents) clientState.subs.add(`agent:${a}`);
        ws.send(JSON.stringify({ type: 'subscribed', agents, events }));
      }

      if (msg.type === 'unsubscribe') {
        const events = msg.events || [];
        const agents = msg.agents || [];
        for (const e of events) clientState.subs.delete(`event:${e}`);
        for (const a of agents) clientState.subs.delete(`agent:${a}`);
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.addEventListener('close', () => {
    clients.delete(ws);
    if (clients.size === 0) stopHeartbeat();
    logger.info('WebSocket client disconnected');
  });
}

function authenticateWs(token: string): boolean {
  if (!wsAuthToken && (!wsApiKeys || wsApiKeys.size === 0)) return true;
  if (wsAuthToken && token === wsAuthToken) return true;
  if (wsApiKeys && wsApiKeys.has(token)) return true;
  return false;
}

function broadcastEvent(eventName: string, data: any) {
  const payload = JSON.stringify({ type: eventName, ...data, timestamp: Date.now() });
  for (const [ws, state] of clients) {
    if (ws.readyState !== WS_OPEN) continue;
    if (!isAuthenticated(state)) continue;

    // Check event subscription filter
    if (state.subs.size > 0) {
      const hasEventSub = state.subs.has(`event:${eventName}`);
      const hasAgentSub = data.agentId && state.subs.has(`agent:${data.agentId}`);
      const hasGlobalSub = state.subs.has('event:*');
      // If they have specific subs but none match, skip
      const hasAnySpecificSub = [...state.subs].some((s) => s.startsWith('event:') || s.startsWith('agent:'));
      if (hasAnySpecificSub && !hasEventSub && !hasAgentSub && !hasGlobalSub) continue;
    }

    // Legacy: if client subscribed to specific agents only
    if (data.agentId && state.subs.size > 0) {
      const hasAgent = state.subs.has(`agent:${data.agentId}`);
      const hasAnySpecificAgent = [...state.subs].some((s) => s.startsWith('agent:'));
      if (hasAnySpecificAgent && !hasAgent) continue;
    }

    try {
      ws.send(payload);
    } catch {
      clients.delete(ws);
    }
  }
}

// Subscribe to all broadcast events from the event bus
for (const ev of ALL_BROADCAST_EVENTS) {
  eventBus.on(ev, (data: any) => broadcastEvent(ev, data));
}

/** Broadcast a raw message to all connected WebSocket clients */
export function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const [ws, state] of clients) {
    if (ws.readyState === WS_OPEN && isAuthenticated(state)) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  }
}
