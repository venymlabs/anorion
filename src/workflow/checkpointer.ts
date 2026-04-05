// SqliteCheckpointer — persist graph state snapshots in SQLite

import type { Checkpoint, Checkpointer } from './types';
import { logger } from '../shared/logger';

let dbInstance: any = null;

function getDb(): any {
  if (!dbInstance) {
    const { Database } = require('bun:sqlite');
    dbInstance = new Database(':memory:');
    dbInstance.exec('PRAGMA journal_mode = WAL');
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS graph_checkpoints (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        parent_id TEXT,
        metadata TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_graph_thread ON graph_checkpoints(graph_id, thread_id, created_at DESC);
    `);
  }
  return dbInstance;
}

/**
 * Optionally initialize with a persistent DB path.
 * Call this before first use if you want disk persistence.
 */
export function initCheckpointerDb(dbPath: string): void {
  const { Database } = require('bun:sqlite');
  const { mkdirSync } = require('fs');
  const { resolve, dirname } = require('path');

  const full = resolve(process.cwd(), dbPath);
  mkdirSync(dirname(full), { recursive: true });

  dbInstance = new Database(full);
  dbInstance.exec('PRAGMA journal_mode = WAL');
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS graph_checkpoints (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      parent_id TEXT,
      metadata TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_graph_thread ON graph_checkpoints(graph_id, thread_id, created_at DESC);
  `);
  logger.info({ path: full }, 'Checkpointer DB initialized');
}

export class SqliteCheckpointer implements Checkpointer {
  async save(checkpoint: Checkpoint): Promise<void> {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO graph_checkpoints (id, graph_id, thread_id, node_id, state, created_at, parent_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpoint.id,
      checkpoint.graphId,
      checkpoint.threadId,
      checkpoint.nodeId,
      JSON.stringify(checkpoint.state),
      checkpoint.createdAt,
      checkpoint.parentId,
      JSON.stringify(checkpoint.metadata),
    );
  }

  async load(id: string): Promise<Checkpoint | null> {
    const db = getDb();
    const row = db.prepare('SELECT * FROM graph_checkpoints WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      graphId: row.graph_id,
      threadId: row.thread_id,
      nodeId: row.node_id,
      state: JSON.parse(row.state),
      createdAt: row.created_at,
      parentId: row.parent_id,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  async list(
    graphId: string,
    threadId: string,
    options?: { limit?: number },
  ): Promise<Checkpoint[]> {
    const db = getDb();
    const limit = options?.limit ?? 100;
    const rows = db
      .prepare(
        'SELECT * FROM graph_checkpoints WHERE graph_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(graphId, threadId, limit) as any[];

    return rows.map((row) => ({
      id: row.id,
      graphId: row.graph_id,
      threadId: row.thread_id,
      nodeId: row.node_id,
      state: JSON.parse(row.state),
      createdAt: row.created_at,
      parentId: row.parent_id,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  async getLatest(graphId: string, threadId: string): Promise<Checkpoint | null> {
    const results = await this.list(graphId, threadId, { limit: 1 });
    return results[0] ?? null;
  }
}
