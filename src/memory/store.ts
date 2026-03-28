import { type Database } from 'bun:sqlite';
import { logger } from '../shared/logger';

export type MemoryCategory = 'identity' | 'preference' | 'fact' | 'lesson' | 'context';

export interface MemoryFileEntry {
  key: string;
  value: unknown;
  category: MemoryCategory;
  createdAt: string;
  updatedAt: string;
}

class LRUCache<T> {
  private cache = new Map<string, T>();

  constructor(private maxSize: number) {}

  get(key: string): T | undefined {
    const val = this.cache.get(key);
    if (val !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const first = this.cache.keys().next().value!;
      this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

class MemoryManager {
  private db: Database | null = null;
  private stmtCache = new Map<string, ReturnType<Database['prepare']>>();
  private cache = new LRUCache<MemoryFileEntry[]>(500);

  setDb(db: Database): void {
    this.db = db;
  }

  private getDb(): Database {
    if (!this.db) throw new Error('MemoryManager: DB not set — call setDb() first');
    return this.db;
  }

  private stmt(sql: string) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.getDb().prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private invalidateAgent(agentId: string): void {
    this.cache.deleteByPrefix(`list:${agentId}:`);
  }

  save(agentId: string, category: MemoryCategory, key: string, value: unknown): MemoryFileEntry {
    const now = new Date().toISOString();
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);

    // Preserve createdAt on update
    const existing = this.stmt(
      'SELECT created_at FROM memory_entries WHERE agent_id = ? AND key = ?',
    ).get(agentId, key) as { created_at: string } | null;

    const createdAt = existing?.created_at ?? now;

    this.stmt(`
      INSERT INTO memory_entries (id, agent_id, key, value, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, key) DO UPDATE SET
        value = excluded.value,
        category = excluded.category,
        updated_at = excluded.updated_at
    `).run(crypto.randomUUID(), agentId, key, valueStr, category, createdAt, now);

    this.invalidateAgent(agentId);
    logger.debug({ agentId, category, key }, 'Memory saved');

    return { key, value, category, createdAt, updatedAt: now };
  }

  load(agentId: string): MemoryFileEntry[] {
    const cacheKey = `list:${agentId}:all`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = this.stmt(
      'SELECT key, value, category, created_at, updated_at FROM memory_entries WHERE agent_id = ? ORDER BY updated_at DESC',
    ).all(agentId) as Record<string, string>[];

    const entries = rows.map((r) => this.rowToEntry(r));
    this.cache.set(cacheKey, entries);
    return entries;
  }

  loadByCategory(agentId: string, category: MemoryCategory): MemoryFileEntry[] {
    const rows = this.stmt(
      'SELECT key, value, category, created_at, updated_at FROM memory_entries WHERE agent_id = ? AND category = ? ORDER BY updated_at DESC',
    ).all(agentId, category) as Record<string, string>[];

    return rows.map((r) => this.rowToEntry(r));
  }

  search(agentId: string, query: string): MemoryFileEntry[] {
    if (!query.trim()) return this.load(agentId);

    const db = this.getDb();
    // Prefix-match tokens for FTS5
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .map((t) => `${t}*`)
      .join(' ');

    const rows = db
      .prepare(
        `SELECT me.key, me.value, me.category, me.created_at, me.updated_at
         FROM memory_entries me
         JOIN memory_fts fts ON me.rowid = fts.rowid
         WHERE me.agent_id = ? AND memory_fts MATCH ?
         ORDER BY rank`,
      )
      .all(agentId, ftsQuery) as Record<string, string>[];

    return rows.map((r) => this.rowToEntry(r));
  }

  forget(agentId: string, key: string): boolean {
    const result = this.stmt(
      'DELETE FROM memory_entries WHERE agent_id = ? AND key = ?',
    ).run(agentId, key);

    if (result.changes > 0) {
      this.invalidateAgent(agentId);
      logger.debug({ agentId, key }, 'Memory forgotten');
      return true;
    }
    return false;
  }

  getByKey(agentId: string, key: string): MemoryFileEntry | null {
    const row = this.stmt(
      'SELECT key, value, category, created_at, updated_at FROM memory_entries WHERE agent_id = ? AND key = ?',
    ).get(agentId, key) as Record<string, string> | null;

    return row ? this.rowToEntry(row) : null;
  }

  clear(agentId: string): boolean {
    const result = this.stmt(
      'DELETE FROM memory_entries WHERE agent_id = ?',
    ).run(agentId);

    this.invalidateAgent(agentId);

    if (result.changes > 0) {
      logger.info({ agentId }, 'All memory cleared');
      return true;
    }
    return false;
  }

  /** Build a memory context string for injection into system prompts */
  buildContext(agentId: string): string {
    const entries = this.load(agentId);
    if (entries.length === 0) return '';

    const lines: string[] = ['[Agent Memory]'];
    for (const entry of entries) {
      const val = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      lines.push(`- [${entry.category}] ${entry.key}: ${val}`);
    }
    return lines.join('\n');
  }

  private rowToEntry(row: Record<string, string | undefined>): MemoryFileEntry {
    const raw = row.value ?? '';
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // value is a plain string
    }
    return {
      key: row.key ?? '',
      value,
      category: (row.category ?? 'fact') as MemoryCategory,
      createdAt: row.created_at ?? '',
      updatedAt: row.updated_at ?? '',
    };
  }
}

export const memoryManager = new MemoryManager();
