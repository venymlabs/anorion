// SQLite-vec Adapter — zero-dependency vector store using bun:sqlite
// Stores vectors as BLOB (Float32Array) and computes cosine similarity in-app

import { type Database, type SQLQueryBindings } from 'bun:sqlite';
import { logger } from '../../../shared/logger';
import type { VectorStoreAdapter, VectorRecord, VectorSearchResult, VectorSearchQuery, VectorMetadata } from '../types';

function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function vectorToBlob(vec: Float32Array | number[]): Buffer {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToVector(blob: Buffer, dimensions: number): Float32Array {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob as unknown as ArrayBuffer);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

export class SqliteVecAdapter implements VectorStoreAdapter {
  private stmtCache = new Map<string, ReturnType<Database['prepare']>>();
  private dimensions: number;

  constructor(
    private db: Database,
    private config: { dimensions: number },
  ) {
    this.dimensions = config.dimensions;
  }

  async initialize(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        vector BLOB NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_vectors_agent ON vectors(agent_id);

      -- FTS5 for hybrid keyword search
      CREATE VIRTUAL TABLE IF NOT EXISTS vectors_fts USING fts5(
        content,
        content='vectors',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS vectors_fts_ai AFTER INSERT ON vectors BEGIN
        INSERT INTO vectors_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS vectors_fts_ad AFTER DELETE ON vectors BEGIN
        INSERT INTO vectors_fts(vectors_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS vectors_fts_au AFTER UPDATE ON vectors BEGIN
        INSERT INTO vectors_fts(vectors_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO vectors_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
    logger.info('SQLite-vec adapter initialized');
  }

  private stmt(sql: string) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  async upsert(record: VectorRecord): Promise<void> {
    const meta: VectorMetadata = record.metadata;
    this.stmt(`
      INSERT INTO vectors (id, agent_id, vector, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        vector = excluded.vector,
        content = excluded.content,
        metadata = excluded.metadata
    `).run(
      record.id,
      meta.agentId,
      vectorToBlob(record.vector),
      record.content,
      JSON.stringify(meta),
      meta.createdAt,
    );
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    const insert = this.stmt(`
      INSERT INTO vectors (id, agent_id, vector, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        vector = excluded.vector,
        content = excluded.content,
        metadata = excluded.metadata
    `);

    const tx = this.db.transaction((items: VectorRecord[]) => {
      for (const r of items) {
        insert.run(
          r.id,
          r.metadata.agentId,
          vectorToBlob(r.vector),
          r.content,
          JSON.stringify(r.metadata),
          r.metadata.createdAt,
        );
      }
    });
    tx(records);
  }

  async search(query: VectorSearchQuery, queryVector: number[]): Promise<VectorSearchResult[]> {
    const limit = query.limit ?? 10;
    const minScore = query.minScore ?? 0.5;
    const agentId = query.agentId;

    // Build metadata filters
    let sql = 'SELECT id, vector, content, metadata FROM vectors WHERE agent_id = ?';
    const params: unknown[] = [agentId];

    if (query.sourceType) {
      sql += " AND json_extract(metadata, '$.source') = ?";
      params.push(query.sourceType);
    }
    if (query.sessionId) {
      sql += " AND json_extract(metadata, '$.sessionId') = ?";
      params.push(query.sessionId);
    }
    if (query.tags && query.tags.length > 0) {
      // Filter for records that contain any of the requested tags
      const tagClauses = query.tags.map(() => "json_extract(metadata, '$.tags') LIKE ?");
      sql += ` AND (${tagClauses.join(' OR ')})`;
      for (const tag of query.tags) {
        params.push(`%"${tag}"%`);
      }
    }

    // Fetch candidates
    const rows = this.stmt(sql).all(...(params as SQLQueryBindings[])) as Array<{
      id: string;
      vector: Buffer;
      content: string;
      metadata: string;
    }>;

    // Compute cosine similarity
    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const vec = blobToVector(row.vector, this.dimensions);
      const score = cosineSimilarity(queryVector, vec);
      if (score >= minScore) {
        const meta = JSON.parse(row.metadata) as VectorMetadata;
        results.push({
          record: {
            id: row.id,
            vector: vec,
            content: row.content,
            metadata: meta,
          },
          score,
          matchType: 'vector',
        });
      }
    }

    // If hybrid mode, also do keyword search and merge
    if (query.hybrid !== false) {
      const ftsResults = this.keywordSearch(agentId, query);
      const vectorWeight = query.vectorWeight ?? 0.7;
      const keywordWeight = 1 - vectorWeight;

      // Build map of vector results
      const resultMap = new Map<string, VectorSearchResult>();
      for (const r of results) {
        resultMap.set(r.record.id, { ...r, score: r.score * vectorWeight });
      }

      // Merge keyword results
      for (const r of ftsResults) {
        const existing = resultMap.get(r.record.id);
        if (existing) {
          // Hybrid: combine scores
          existing.score = existing.score + r.score * keywordWeight;
          existing.matchType = 'hybrid';
        } else {
          // Keyword-only result
          const adjusted = r.score * keywordWeight;
          if (adjusted >= minScore) {
            resultMap.set(r.record.id, { ...r, score: adjusted, matchType: 'keyword' });
          }
        }
      }

      // Replace results with merged
      results.length = 0;
      results.push(...resultMap.values());
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private keywordSearch(agentId: string, query: VectorSearchQuery): VectorSearchResult[] {
    const ftsQuery = query.query
      .trim()
      .split(/\s+/)
      .map((t) => `${t}*`)
      .join(' ');

    const limit = query.limit ?? 10;
    const rows = this.db.prepare(`
      SELECT v.id, v.vector, v.content, v.metadata, fts.rank
      FROM vectors v
      JOIN vectors_fts fts ON v.rowid = fts.rowid
      WHERE v.agent_id = ? AND vectors_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `).all(agentId, ftsQuery, limit * 3) as Array<{
      id: string;
      vector: Buffer;
      content: string;
      metadata: string;
      rank: number;
    }>;

    // Normalize BM25 rank to 0-1 range
    const maxRank = Math.max(...rows.map((r) => Math.abs(r.rank)), 1);

    return rows.map((row) => {
      const meta = JSON.parse(row.metadata) as VectorMetadata;
      const normalizedScore = Math.min(1, Math.abs(row.rank) / maxRank);
      return {
        record: {
          id: row.id,
          vector: blobToVector(row.vector, this.dimensions),
          content: row.content,
          metadata: meta,
        },
        score: normalizedScore,
        matchType: 'keyword' as const,
      };
    });
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.stmt(`DELETE FROM vectors WHERE id IN (${placeholders})`).run(...ids);
  }

  async deleteByMetadata(agentId: string, filters: Partial<VectorMetadata>): Promise<number> {
    let sql = 'DELETE FROM vectors WHERE agent_id = ?';
    const params: unknown[] = [agentId];

    if (filters.source) {
      sql += " AND json_extract(metadata, '$.source') = ?";
      params.push(filters.source);
    }
    if (filters.sessionId) {
      sql += " AND json_extract(metadata, '$.sessionId') = ?";
      params.push(filters.sessionId);
    }
    if (filters.sourceId) {
      sql += " AND json_extract(metadata, '$.sourceId') = ?";
      params.push(filters.sourceId);
    }
    if (filters.filePath) {
      sql += " AND json_extract(metadata, '$.filePath') = ?";
      params.push(filters.filePath);
    }

    const result = this.stmt(sql).run(...(params as SQLQueryBindings[]));
    return result.changes;
  }

  async get(id: string): Promise<VectorRecord | null> {
    const row = this.stmt(
      'SELECT id, vector, content, metadata FROM vectors WHERE id = ?',
    ).get(id) as { id: string; vector: Buffer; content: string; metadata: string } | null;

    if (!row) return null;

    return {
      id: row.id,
      vector: blobToVector(row.vector, this.dimensions),
      content: row.content,
      metadata: JSON.parse(row.metadata) as VectorMetadata,
    };
  }

  async count(agentId: string): Promise<number> {
    const row = this.stmt(
      'SELECT COUNT(*) as cnt FROM vectors WHERE agent_id = ?',
    ).get(agentId) as { cnt: number };
    return row.cnt;
  }

  async cleanup(): Promise<number> {
    const now = new Date();
    const rows = this.stmt(
      "SELECT id, metadata FROM vectors WHERE json_extract(metadata, '$.ttl') > 0",
    ).all() as Array<{ id: string; metadata: string }>;

    const expired: string[] = [];
    for (const row of rows) {
      const meta = JSON.parse(row.metadata) as VectorMetadata;
      if (meta.ttl > 0 && meta.createdAt) {
        const expires = new Date(meta.createdAt).getTime() + meta.ttl * 1000;
        if (now.getTime() > expires) {
          expired.push(row.id);
        }
      }
    }

    if (expired.length > 0) {
      await this.delete(expired);
      logger.info({ count: expired.length }, 'Cleaned up expired vectors');
    }
    return expired.length;
  }

  async close(): Promise<void> {
    this.stmtCache.clear();
  }
}
