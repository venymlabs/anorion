// Simple typed pub/sub event bus for decoupled communication
// Used by runtime → WS broadcasting, metrics, audit log, etc.

type EventHandler<T = unknown> = (event: T) => void;

interface EventSubscription {
  unsubscribe: () => void;
}

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private onceHandlers = new Map<string, Set<EventHandler>>();

  on<T>(event: string, handler: EventHandler<T>): EventSubscription {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const set = this.handlers.get(event)!;
    const wrapped = handler as EventHandler;
    set.add(wrapped);
    return { unsubscribe: () => set.delete(wrapped) };
  }

  once<T>(event: string, handler: EventHandler<T>): void {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }
    this.onceHandlers.get(event)!.add(handler as EventHandler);
  }

  emit<T>(event: string, data: T): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const h of handlers) {
        try { h(data); } catch { /* swallow */ }
      }
    }
    const once = this.onceHandlers.get(event);
    if (once) {
      this.onceHandlers.delete(event);
      for (const h of once) {
        try { h(data); } catch { /* swallow */ }
      }
    }
  }

  removeAllFor(event: string): void {
    this.handlers.delete(event);
    this.onceHandlers.delete(event);
  }

  eventNames(): string[] {
    return [...new Set([...this.handlers.keys(), ...this.onceHandlers.keys()])];
  }
}

export const eventBus = new EventBus();

// Typed event definitions
export interface AgentEvents {
  'agent:processing': { agentId: string; sessionId: string; timestamp: number };
  'agent:tool-call': { agentId: string; sessionId: string; toolName: string; toolCallId: string; timestamp: number };
  'agent:response': { agentId: string; sessionId: string; content: string; durationMs: number; tokensUsed?: number; timestamp: number };
  'agent:error': { agentId: string; sessionId: string; error: string; timestamp: number };
  'agent:idle': { agentId: string; timestamp: number };
  'session:created': { sessionId: string; agentId: string; timestamp: number };
  'session:destroyed': { sessionId: string; agentId: string; timestamp: number };
  'session:idle': { sessionId: string; agentId: string; timestamp: number };
  'tool:executed': { agentId: string; sessionId: string; toolName: string; durationMs: number; success: boolean; timestamp: number };
  'bridge:peer:connected': { gatewayId: string; url: string; timestamp: number };
  'bridge:peer:disconnected': { gatewayId: string; url: string; timestamp: number };
  'bridge:message:forwarded': { gatewayId: string; targetAgentId: string; timestamp: number };
  'memory:saved': { agentId: string; key: string; category: string; timestamp: number };
  'memory:forgotten': { agentId: string; key: string; timestamp: number };
  'schedule:executed': { scheduleId: string; agentId: string; success: boolean; timestamp: number };
  'token:usage': { agentId: string; sessionId: string; model: string; promptTokens: number; completionTokens: number; timestamp: number };
}

export type EventName = keyof AgentEvents;
