import type { Session, Message, ToolCall, ToolResultEntry } from '../shared/types';
import type { Db } from '../shared/db';
import type { PreparedStatements } from '../shared/db/prepared';
import { logger } from '../shared/logger';

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_IN_MEMORY_SESSIONS = 500;

class SessionManager {
  private sessions = new Map<string, Session>();
  private db: Db | null = null;
  private prepared: PreparedStatements | null = null;
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  private ttlMs = DEFAULT_TTL_MS;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  setTtl(ms: number): void {
    this.ttlMs = ms;
  }

  startIdleChecker(): void {
    if (this.idleCheckInterval) return;
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleSessions();
    }, 60_000); // check every minute
  }

  stopIdleChecker(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  private checkIdleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status !== 'active' && session.status !== 'idle') continue;

      const lastActive = new Date(session.lastActive).getTime();
      const age = new Date(session.createdAt).getTime();

      // Check TTL
      if (now - age > this.ttlMs) {
        logger.info({ sessionId: id, age: now - age }, 'Session TTL expired, destroying');
        this.destroy(id);
        continue;
      }

      // Check idle
      if (session.status === 'active' && now - lastActive > this.idleTimeoutMs) {
        session.status = 'idle';
        session.updatedAt = new Date().toISOString();
        logger.info({ sessionId: id, idleFor: now - lastActive }, 'Session marked idle');
      }
    }

    this.evictIfNeeded();
  }

  /** Evict oldest idle/destroyed sessions when the in-memory map exceeds the cap. */
  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_IN_MEMORY_SESSIONS) return;

    // Collect candidates: prefer evicting idle/destroyed sessions first
    const candidates: Array<{ id: string; lastActive: number }> = [];
    for (const [id, s] of this.sessions) {
      if (s.status === 'idle' || s.status === 'destroyed') {
        candidates.push({ id, lastActive: new Date(s.lastActive).getTime() });
      }
    }

    // Sort oldest-first
    candidates.sort((a, b) => a.lastActive - b.lastActive);

    const toEvict = this.sessions.size - MAX_IN_MEMORY_SESSIONS;
    let evicted = 0;
    for (const { id } of candidates) {
      if (evicted >= toEvict) break;
      // Mark destroyed in DB before dropping from memory
      if (this.prepared) {
        const session = this.sessions.get(id);
        if (session && session.status === 'idle') {
          this.prepared.sessionSetStatus.run({ $id: id, $status: 'destroyed', $updatedAt: new Date().toISOString() });
        }
      }
      this.sessions.delete(id);
      evicted++;
      logger.debug({ sessionId: id }, 'Session evicted from memory');
    }

    // If still over cap after evicting idle/destroyed, drop oldest active sessions too
    if (this.sessions.size > MAX_IN_MEMORY_SESSIONS) {
      const all = [...this.sessions.entries()]
        .sort(([, a], [, b]) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime());
      while (this.sessions.size > MAX_IN_MEMORY_SESSIONS && all.length) {
        const [id] = all.shift()!;
        this.sessions.delete(id);
        logger.debug({ sessionId: id }, 'Session evicted from memory (overflow)');
      }
    }
  }

  setDb(db: Db, prepared: PreparedStatements): void {
    this.db = db;
    this.prepared = prepared;
  }

  async create(agentId: string, channelId?: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: crypto.randomUUID().slice(0, 12),
      agentId,
      channelId,
      status: 'active',
      tokensUsed: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastActive: now,
    };

    this.sessions.set(session.id, session);
    this.evictIfNeeded();

    if (this.prepared) {
      this.prepared.sessionInsert.run({
        $id: session.id,
        $agentId,
        $channelId: channelId ?? null,
        $status: 'active',
        $tokensUsed: 0,
        $messageCount: 0,
        $createdAt: session.createdAt,
        $updatedAt: session.updatedAt,
        $lastActive: session.lastActive,
      });
    }

    logger.debug({ sessionId: session.id, agentId }, 'Session created');
    return session;
  }

  get(id: string): Session | undefined {
    const cached = this.sessions.get(id);
    if (cached) return cached;

    // Lazy-load from DB if available
    if (this.db) {
      // Fire-and-forget — callers that need the result immediately should use getOrLoad
      return undefined;
    }
    return undefined;
  }

  /** Get a session, lazily loading from DB if not in memory. */
  async getOrLoad(id: string): Promise<Session | undefined> {
    const cached = this.sessions.get(id);
    if (cached) return cached;

    if (!this.prepared) return undefined;

    const row = this.prepared.sessionGetById.get({ $id: id }) as any;
    if (!row) return undefined;

    const session: Session = {
      id: row.id,
      agentId: row.agent_id,
      channelId: row.channel_id ?? undefined,
      status: row.status as Session['status'],
      tokensUsed: row.tokens_used ?? 0,
      messageCount: row.message_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActive: row.last_active,
    };

    this.sessions.set(id, session);
    return session;
  }

  async listByAgent(agentId: string): Promise<Session[]> {
    if (this.prepared) {
      const rows = this.prepared.sessionListByAgent.all({ $agentId: agentId }) as any[];
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        channelId: r.channel_id ?? undefined,
        status: r.status as Session['status'],
        tokensUsed: r.tokens_used ?? 0,
        messageCount: r.message_count ?? 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastActive: r.last_active,
      }));
    }
    return [...this.sessions.values()].filter((s) => s.agentId === agentId);
  }

  async addMessage(msg: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const message: Message = {
      ...msg,
      id: crypto.randomUUID().slice(0, 12),
      createdAt: new Date().toISOString(),
    };

    // Update session
    const session = this.sessions.get(msg.sessionId);
    if (session) {
      session.messageCount++;
      session.tokensUsed += (msg.tokensIn || 0) + (msg.tokensOut || 0);
      session.lastActive = new Date().toISOString();
      session.updatedAt = new Date().toISOString();
      // Wake idle session
      if (session.status === 'idle') {
        session.status = 'active';
      }

      // Persist session activity update
      if (this.prepared) {
        this.prepared.sessionUpdateActivity.run({
          $id: session.id,
          $lastActive: session.lastActive,
          $updatedAt: session.updatedAt,
          $tokensUsed: session.tokensUsed,
          $messageCount: session.messageCount,
          $status: session.status,
        });
      }
    }

    if (this.prepared) {
      this.prepared.messageInsert.run({
        $id: message.id,
        $sessionId: msg.sessionId,
        $agentId: msg.agentId,
        $role: msg.role,
        $content: msg.content,
        $toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        $toolResults: msg.toolResults ? JSON.stringify(msg.toolResults) : null,
        $tokensIn: msg.tokensIn ?? null,
        $tokensOut: msg.tokensOut ?? null,
        $model: msg.model ?? null,
        $durationMs: msg.durationMs ?? null,
        $createdAt: message.createdAt,
      });
    }

    return message;
  }

  async getMessages(sessionId: string, limit = 50): Promise<Message[]> {
    if (this.prepared) {
      const rows = this.prepared.messageListBySession.all({ $sessionId: sessionId, $limit: limit }) as any[];
      return rows.reverse().map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        agentId: r.agent_id,
        role: r.role as Message['role'],
        content: r.content,
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
        toolResults: r.tool_results ? JSON.parse(r.tool_results) : undefined,
        tokensIn: r.tokens_in ?? undefined,
        tokensOut: r.tokens_out ?? undefined,
        model: r.model ?? undefined,
        durationMs: r.duration_ms ?? undefined,
        createdAt: r.created_at,
      }));
    }
    return [];
  }

  async destroy(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);

    if (this.prepared) {
      this.prepared.sessionSetStatus.run({ $id: sessionId, $status: 'destroyed', $updatedAt: new Date().toISOString() });
    }

    return true;
  }
}

export const sessionManager = new SessionManager();
