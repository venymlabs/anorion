import type { Session, Message, ToolCall, ToolResultEntry } from '../shared/types';
import type { Db } from '../shared/db';
import { sessions, messages } from '../shared/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { logger } from '../shared/logger';

class SessionManager {
  private sessions = new Map<string, Session>();
  private db: Db | null = null;

  setDb(db: Db): void {
    this.db = db;
  }

  async create(agentId: string, channelId?: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: nanoid(12),
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

    if (this.db) {
      await this.db.insert(sessions).values({
        id: session.id,
        agentId,
        channelId,
        status: 'active',
        tokensUsed: 0,
        messageCount: 0,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastActive: session.lastActive,
      });
    }

    logger.debug({ sessionId: session.id, agentId }, 'Session created');
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async listByAgent(agentId: string): Promise<Session[]> {
    if (this.db) {
      const rows = await this.db.select().from(sessions)
        .where(eq(sessions.agentId, agentId))
        .orderBy(desc(sessions.lastActive));
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        channelId: r.channelId ?? undefined,
        status: r.status as Session['status'],
        tokensUsed: r.tokensUsed ?? 0,
        messageCount: r.messageCount ?? 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastActive: r.lastActive,
      }));
    }
    return [...this.sessions.values()].filter((s) => s.agentId === agentId);
  }

  async addMessage(msg: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const message: Message = {
      ...msg,
      id: nanoid(12),
      createdAt: new Date().toISOString(),
    };

    // Update session
    const session = this.sessions.get(msg.sessionId);
    if (session) {
      session.messageCount++;
      session.tokensUsed += (msg.tokensIn || 0) + (msg.tokensOut || 0);
      session.lastActive = new Date().toISOString();
      session.updatedAt = new Date().toISOString();
    }

    if (this.db) {
      await this.db.insert(messages).values({
        id: message.id,
        sessionId: msg.sessionId,
        agentId: msg.agentId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        toolResults: msg.toolResults ? JSON.stringify(msg.toolResults) : null,
        tokensIn: msg.tokensIn,
        tokensOut: msg.tokensOut,
        model: msg.model,
        durationMs: msg.durationMs,
        createdAt: message.createdAt,
      });
    }

    return message;
  }

  async getMessages(sessionId: string, limit = 50): Promise<Message[]> {
    if (this.db) {
      const rows = await this.db.select().from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(limit);
      return rows.reverse().map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        agentId: r.agentId,
        role: r.role as Message['role'],
        content: r.content,
        toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : undefined,
        toolResults: r.toolResults ? JSON.parse(r.toolResults) : undefined,
        tokensIn: r.tokensIn ?? undefined,
        tokensOut: r.tokensOut ?? undefined,
        model: r.model ?? undefined,
        durationMs: r.durationMs ?? undefined,
        createdAt: r.createdAt,
      }));
    }
    return [];
  }

  async destroy(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);

    if (this.db) {
      await this.db.update(sessions).set({ status: 'destroyed' }).where(eq(sessions.id, sessionId));
    }

    return true;
  }
}

export const sessionManager = new SessionManager();
