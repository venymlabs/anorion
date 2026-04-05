import type { Statement } from 'bun:sqlite';
import type { PreparedStatements } from '../shared/db/prepared';
import { logger } from '../shared/logger';

export interface SearchResult {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  rank: number;
  createdAt: string;
  /** Highlighted snippet with <mark> tags around matches */
  snippet?: string;
}

export interface SearchOptions {
  query: string;
  agentId?: string;
  sessionId?: string;
  limit?: number;
}

class SearchEngine {
  private prepared: PreparedStatements | null = null;
  private snippetFn: Statement | null = null;

  setPrepared(prepared: PreparedStatements): void {
    this.prepared = prepared;
  }

  /** Set the raw sqlite DB so we can build ad-hoc FTS snippet queries. */
  setRawDb(db: import('bun:sqlite').Database): void {
    this.snippetFn = db.prepare(
      `SELECT snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) as snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH $query AND m.id = $messageId`,
    );
  }

  search(options: SearchOptions): SearchResult[] {
    if (!this.prepared) return [];

    const { query, agentId, sessionId, limit = 20 } = options;

    // Sanitize query for FTS5 — wrap in quotes if it contains special chars
    const safeQuery = this.sanitizeQuery(query);
    if (!safeQuery) return [];

    try {
      const rows = this.prepared.messageSearch.all({
        $query: safeQuery,
        $agentId: agentId ?? null,
        $sessionId: sessionId ?? null,
        $limit: limit,
      }) as any[];

      return rows.map((r) => {
        let snippet: string | undefined;
        try {
          if (this.snippetFn) {
            const snipRow = this.snippetFn.get({ $query: safeQuery, $messageId: r.id }) as any;
            snippet = snipRow?.snippet ?? undefined;
          }
        } catch {
          // snippet generation is best-effort
        }

        return {
          id: r.id,
          sessionId: r.session_id,
          agentId: r.agent_id,
          role: r.role,
          content: r.content,
          rank: r.rank,
          createdAt: r.created_at,
          snippet,
        };
      });
    } catch (err) {
      logger.error({ error: (err as Error).message, query }, 'FTS search failed');
      return [];
    }
  }

  private sanitizeQuery(query: string): string {
    // Remove characters that could break FTS5 syntax
    const cleaned = query.replace(/[{}()*+"|&:]/g, ' ').trim();
    if (!cleaned) return '';

    // Split into words and rejoin with AND for multi-word queries
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';
    return words.map((w) => `"${w}"`).join(' ');
  }
}

export const searchEngine = new SearchEngine();
