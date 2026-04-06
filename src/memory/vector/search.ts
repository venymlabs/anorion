// Semantic Search — high-level search over vector store with embedding generation

import type { VectorStoreAdapter, VectorSearchQuery, VectorSearchResult, VectorStoreConfig } from './types';
import { generateEmbedding } from './embeddings';
import { logger } from '../../shared/logger';

export class SemanticSearch {
  constructor(
    private store: VectorStoreAdapter,
    private config: VectorStoreConfig,
  ) {}

  /** Search for semantically similar content */
  async search(query: Omit<VectorSearchQuery, 'hybrid'> & { hybrid?: boolean }): Promise<VectorSearchResult[]> {
    const start = Date.now();

    // Generate embedding for the query
    const { vector: queryVector } = await generateEmbedding(
      query.query,
      this.config.embeddingModel,
    );

    // Search with hybrid mode by default
    const results = await this.store.search(
      { hybrid: true, ...query },
      queryVector,
    );

    const duration = Date.now() - start;
    logger.debug({
      query: query.query.slice(0, 100),
      agentId: query.agentId,
      results: results.length,
      durationMs: duration,
    }, 'Semantic search completed');

    return results;
  }

  /** Search and return formatted context string for RAG injection */
  async searchForContext(
    query: string,
    agentId: string,
    options?: {
      limit?: number;
      sourceType?: VectorSearchQuery['sourceType'];
      sessionId?: string;
      maxTokens?: number;
    },
  ): Promise<{ context: string; sources: VectorSearchResult[] }> {
    const results = await this.search({
      query,
      agentId,
      limit: options?.limit ?? this.config.defaultSearchLimit,
      sourceType: options?.sourceType,
      sessionId: options?.sessionId,
    });

    // Build context string within token budget
    const maxTokens = options?.maxTokens ?? 4000;
    let usedTokens = 0;
    const contextParts: string[] = [];

    for (const r of results) {
      const estTokens = Math.ceil(r.record.content.length / 4);
      if (usedTokens + estTokens > maxTokens) break;

      const source = r.record.metadata.source;
      const sourceLabel = source === 'message'
        ? `Message (${r.record.metadata.sessionId?.slice(0, 8) ?? 'unknown'})`
        : source === 'document'
          ? `Document (${r.record.metadata.filePath ?? r.record.metadata.sourceId ?? 'unknown'})`
          : source === 'memory'
            ? 'Memory'
            : 'Source';

      contextParts.push(
        `[${sourceLabel}, relevance: ${(r.score * 100).toFixed(0)}%]\n${r.record.content}`,
      );
      usedTokens += estTokens;
    }

    const context = contextParts.length > 0
      ? contextParts.join('\n\n---\n\n')
      : '';

    return { context, sources: results };
  }
}
