import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import * as schema from './schema';
import { PreparedStatements } from './prepared';
import { logger } from '../logger';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseResult {
  db: Db;
  raw: Database;
  prepared: PreparedStatements;
}

export function initDatabase(dbPath: string): DatabaseResult {
  const fullPath = resolve(process.cwd(), dbPath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });

  const sqlite = new Database(fullPath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA synchronous = NORMAL');
  sqlite.exec('PRAGMA cache_size = -20000');
  sqlite.exec('PRAGMA temp_store = MEMORY');
  sqlite.exec('PRAGMA mmap_size = 268435456');

  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,
      fallback_model TEXT,
      system_prompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
      tools TEXT NOT NULL DEFAULT '[]',
      max_iterations INTEGER DEFAULT 10,
      timeout_ms INTEGER DEFAULT 120000,
      state TEXT NOT NULL DEFAULT 'idle',
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      tokens_used INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      tool_results TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      model TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tools (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      schema TEXT NOT NULL,
      category TEXT DEFAULT 'system',
      timeout_ms INTEGER DEFAULT 30000,
      max_output_bytes INTEGER DEFAULT 1000000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      task TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '["*"]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Existing indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_id);

    -- Missing indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active);
    CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_agent ON schedules(agent_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    -- Ensure unique index on (agent_id, key) for upsert support
    DROP INDEX IF EXISTS idx_memory_agent_key;
    CREATE UNIQUE INDEX idx_memory_agent_key ON memory_entries(agent_id, key);
  `);

  // FTS5 full-text search for messages
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content)
        VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content)
        VALUES (new.rowid, new.content);
    END;

    -- Config snapshots table
    CREATE TABLE IF NOT EXISTS config_snapshots (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // FTS5 full-text search for memory entries (external content with sync triggers)
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      key, value, category,
      content='memory_entries',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, key, value, category)
        VALUES (new.rowid, new.key, new.value, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value, category)
        VALUES ('delete', old.rowid, old.key, old.value, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value, category)
        VALUES ('delete', old.rowid, old.key, old.value, old.category);
      INSERT INTO memory_fts(rowid, key, value, category)
        VALUES (new.rowid, new.key, new.value, new.category);
    END;
  `);

  const prepared = new PreparedStatements(sqlite);

  logger.info({ path: fullPath }, 'Database initialized');
  return { db, raw: sqlite, prepared };
}
