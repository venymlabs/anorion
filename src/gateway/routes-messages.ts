// Session Message History API routes
import { Hono } from 'hono';
import { sessionManager } from '../agents/session';
import { sendMessage } from '../agents/runtime';
import { agentRegistry } from '../agents/registry';
import type { PreparedStatements } from '../shared/db/prepared';
import { logger } from '../shared/logger';
import type { Session, Message } from '../shared/types';

const app = new Hono();

let preparedRef: PreparedStatements | null = null;

export function setPreparedForMessages(prepared: PreparedStatements) {
  preparedRef = prepared;
}

function mapSessionRow(r: any): Session {
  return {
    id: r.id,
    agentId: r.agent_id,
    channelId: r.channel_id ?? undefined,
    status: r.status as Session['status'],
    tokensUsed: r.tokens_used ?? 0,
    messageCount: r.message_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActive: r.last_active,
  };
}

function mapMessageRow(r: any): Message {
  return {
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
  };
}

// ── List sessions ──
app.get('/api/v1/sessions', async (c) => {
  const agentId = c.req.query('agentId') || null;
  const status = c.req.query('status') || null;
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');
  const expand = c.req.query('expand') || '';

  if (!preparedRef) {
    // Fallback: load from session manager memory
    const allSessions = await listAllSessionsFallback(agentId, status);
    const paged = allSessions.slice(offset, offset + limit);
    return c.json({
      sessions: paged,
      total: allSessions.length,
      limit,
      offset,
    });
  }

  const countRow = preparedRef.sessionCount.get({
    $agentId: agentId,
    $status: status,
  }) as any;

  const rows = preparedRef.sessionListPaginated.all({
    $agentId: agentId,
    $status: status,
    $limit: limit,
    $offset: offset,
  }) as any[];

  let sessions = rows.map(mapSessionRow);

  // Optionally inline messages
  if (expand.includes('messages')) {
    const msgLimit = parseInt(c.req.query('messageLimit') || '10');
    for (let i = 0; i < sessions.length; i++) {
      const msgs = await sessionManager.getMessages(sessions[i]!.id, msgLimit);
      (sessions[i] as any).messages = msgs;
    }
  }

  return c.json({
    sessions,
    total: countRow?.total ?? sessions.length,
    limit,
    offset,
  });
});

async function listAllSessionsFallback(agentId: string | null, status: string | null): Promise<Session[]> {
  // If we have DB but no prepared ref (shouldn't happen), try session manager
  if (agentId) {
    const sessions = await sessionManager.listByAgent(agentId);
    return status ? sessions.filter((s) => s.status === status) : sessions;
  }
  // No way to list all sessions without DB
  return [];
}

// ── Get session details ──
app.get('/api/v1/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const session = await sessionManager.getOrLoad(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json({ session });
});

// ── Get session messages ──
app.get('/api/v1/sessions/:sessionId/messages', async (c) => {
  const sessionId = c.req.param('sessionId');
  const session = await sessionManager.getOrLoad(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const before = c.req.query('before') || null;
  const after = c.req.query('after') || null;

  // If we have prepared statements and need cursor-based pagination, use them
  if (preparedRef && (before || after)) {
    const rows = preparedRef.messageListBySessionPaginated.all({
      $sessionId: sessionId,
      $before: before,
      $after: after,
      $limit: limit,
    }) as any[];

    const countRow = preparedRef.messageCountBySession.get({
      $sessionId: sessionId,
    }) as any;

    return c.json({
      messages: rows.map(mapMessageRow),
      total: countRow?.total ?? 0,
      limit,
    });
  }

  // Default: load through session manager
  const messages = await sessionManager.getMessages(sessionId, limit);
  return c.json({
    messages,
    total: session.messageCount,
    limit,
  });
});

// ── Delete session ──
app.delete('/api/v1/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  if (preparedRef) {
    preparedRef.sessionDelete.run({ $id: sessionId });
  }

  const destroyed = await sessionManager.destroy(sessionId);
  return c.json({ ok: true, destroyed });
});

// ── Send message to session via REST ──
app.post('/api/v1/sessions/:sessionId/messages', async (c) => {
  const sessionId = c.req.param('sessionId');
  const session = await sessionManager.getOrLoad(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const body = await c.req.json();
  if (!body.text) return c.json({ error: 'text is required' }, 400);

  try {
    const result = await sendMessage({
      agentId: session.agentId,
      sessionId: session.id,
      text: body.text,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'REST message send failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default app;
