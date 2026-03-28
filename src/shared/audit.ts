// Audit Log — immutable record of all agent actions for security and compliance

import { resolve } from 'path';
import { mkdirSync } from 'fs';
import { logger } from '../shared/logger';
import { eventBus } from '../shared/events';

export interface AuditEntry {
  id: number;
  timestamp: string;
  agentId: string;
  sessionId: string;
  action: string;
  details: string;
  success: boolean;
  durationMs?: number;
}

class AuditLogger {
  private db: any = null; // bun:sqlite Database
  private insertStmt: any = null;
  private insertCount = 0;
  private flushBuffer: AuditEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private readonly BUFFER_SIZE = 50;

  init(dbPath?: string): void {
    const path = dbPath || resolve(process.cwd(), 'data', 'audit.db');
    const dir = path.slice(0, path.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });

    // Lazy import bun:sqlite
    const { Database } = require('bun:sqlite');
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `);

    this.insertStmt = this.db.prepare(
      'INSERT INTO audit_log (agent_id, session_id, action, details, success, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // Buffered writes — flush every 5 seconds or when buffer is full
    this.flushInterval = setInterval(() => this.flush(), 5000);

    // Auto-subscribe to events
    this.subscribeToEvents();

    logger.info({ path }, 'Audit logger initialized');
  }

  /** Log an action (buffered) */
  log(entry: Omit<AuditEntry, 'id'>): void {
    if (!this.db) return;
    this.flushBuffer.push({ id: 0, ...entry });
    if (this.flushBuffer.length >= this.BUFFER_SIZE) this.flush();
  }

  /** Query audit log */
  query(filters: {
    agentId?: string;
    sessionId?: string;
    action?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): AuditEntry[] {
    if (!this.db) return [];

    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.action) { conditions.push('action LIKE ?'); params.push(`%${filters.action}%`); }
    if (filters.since) { conditions.push('timestamp >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('timestamp <= ?'); params.push(filters.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const stmt = this.db.prepare(
      `SELECT id, timestamp, agent_id, session_id, action, details, success, duration_ms FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    );

    return stmt.all(...params, limit, offset).map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      agentId: row.agent_id,
      sessionId: row.session_id,
      action: row.action,
      details: row.details,
      success: row.success === 1,
      durationMs: row.duration_ms ?? undefined,
    }));
  }

  /** Get audit stats */
  getStats(): { totalEntries: number; oldestEntry: string | null; newestEntry: string | null } {
    if (!this.db) return { totalEntries: 0, oldestEntry: null, newestEntry: null };

    const count = (this.db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any).count;
    const range = this.db.prepare('SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM audit_log').get() as any;

    return {
      totalEntries: count,
      oldestEntry: range?.oldest || null,
      newestEntry: range?.newest || null,
    };
  }

  /** Clean old entries based on retention policy */
  purge(retentionDays: number): number {
    if (!this.db) return 0;
    const result = this.db.prepare(
      `DELETE FROM audit_log WHERE timestamp < datetime('now', '-${retentionDays} days')`
    ).run();
    logger.info({ deleted: result.changes, retentionDays }, 'Audit log purged');
    return result.changes;
  }

  /** Flush buffered entries to DB */
  private flush(): void {
    if (this.flushBuffer.length === 0) return;
    const batch = this.flushBuffer.splice(0);
    const tx = this.db.transaction((entries: AuditEntry[]) => {
      for (const entry of entries) {
        this.insertStmt.run(
          entry.agentId,
          entry.sessionId,
          entry.action,
          entry.details,
          entry.success ? 1 : 0,
          entry.durationMs ?? null,
        );
      }
    });
    try {
      tx(batch);
      this.insertCount += batch.length;
    } catch (err) {
      logger.error({ error: (err as Error).message, count: batch.length }, 'Audit flush failed');
    }
  }

  private subscribeToEvents(): void {
    eventBus.on('tool:executed', (data) => {
      this.log({
        timestamp: new Date(data.timestamp).toISOString(),
        agentId: data.agentId,
        sessionId: data.sessionId,
        action: `tool:${data.toolName}`,
        details: '',
        success: data.success,
        durationMs: data.durationMs,
      });
    });

    eventBus.on('agent:response', (data) => {
      this.log({
        timestamp: new Date(data.timestamp).toISOString(),
        agentId: data.agentId,
        sessionId: data.sessionId,
        action: 'agent:response',
        details: `tokens: ${data.tokensUsed || 0}, duration: ${data.durationMs}ms`,
        success: true,
        durationMs: data.durationMs,
      });
    });

    eventBus.on('agent:error', (data) => {
      this.log({
        timestamp: new Date(data.timestamp).toISOString(),
        agentId: data.agentId,
        sessionId: data.sessionId,
        action: 'agent:error',
        details: data.error,
        success: false,
      });
    });

    eventBus.on('memory:saved', (data) => {
      this.log({
        timestamp: new Date(data.timestamp).toISOString(),
        agentId: data.agentId,
        sessionId: '',
        action: `memory:save:${data.category}`,
        details: data.key,
        success: true,
      });
    });

    eventBus.on('bridge:message:forwarded', (data) => {
      this.log({
        timestamp: new Date(data.timestamp).toISOString(),
        agentId: data.targetAgentId,
        sessionId: '',
        action: 'bridge:message:forward',
        details: `gateway: ${data.gatewayId}`,
        success: true,
      });
    });
  }

  shutdown(): void {
    this.flush();
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.db) this.db.close();
  }
}

export const auditLog = new AuditLogger();
