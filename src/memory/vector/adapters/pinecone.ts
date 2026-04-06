// Pinecone Adapter — optional cloud vector store
// Requires Pinecone API key and index

import type { VectorStoreAdapter, VectorRecord, VectorSearchResult, VectorSearchQuery, VectorMetadata } from '../types';
import { logger } from '../../../shared/logger';

export interface PineconeConfig {
  apiKey: string;
  indexName: string;
  environment?: string;
}

export class PineconeAdapter implements VectorStoreAdapter {
  private index: any = null;

  constructor(private config: PineconeConfig) {}

  async initialize(): Promise<void> {
    let Pinecone: any;
    try {
// @ts-expect-error -- pinecone types optional
      const mod = await import('@pinecone-database/pinecone');
      Pinecone = mod.Pinecone;
    } catch {
      throw new Error(
        '@pinecone-database/pinecone not installed. Install with: bun add @pinecone-database/pinecone',
      );
    }

    const client = new Pinecone({ apiKey: this.config.apiKey });
    this.index = client.index(this.config.indexName);

    logger.info({ index: this.config.indexName }, 'Pinecone adapter initialized');
  }

  async upsert(record: VectorRecord): Promise<void> {
    await this.index.upsert([
      {
        id: record.id,
        values: Array.from(record.vector),
        metadata: {
          content: record.content,
          ...(record.metadata as unknown as Record<string, unknown>),
        },
      },
    ]);
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.index.upsert(
        batch.map((r) => ({
          id: r.id,
          values: Array.from(r.vector),
          metadata: {
            content: r.content,
            ...(r.metadata as unknown as Record<string, unknown>),
          },
        })),
      );
    }
  }

  async search(query: VectorSearchQuery, queryVector: number[]): Promise<VectorSearchResult[]> {
    const filter: Record<string, unknown> = { agentId: { $eq: query.agentId } };
    if (query.sourceType) filter.source = { $eq: query.sourceType };
    if (query.sessionId) filter.sessionId = { $eq: query.sessionId };

    const result = await this.index.query({
      vector: queryVector,
      topK: query.limit ?? 10,
      filter,
      includeMetadata: true,
    });

    const results: VectorSearchResult[] = [];
    for (const match of result.matches ?? []) {
      const score = match.score ?? 0;
      if (score >= (query.minScore ?? 0.5)) {
        const meta = match.metadata ?? {};
        results.push({
          record: {
            id: match.id,
            vector: [],
            content: (meta.content as string) ?? '',
            metadata: meta as unknown as VectorMetadata,
          },
          score,
          matchType: 'vector',
        });
      }
    }

    return results;
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.index.deleteMany(ids);
    }
  }

  async deleteByMetadata(agentId: string, filters: Partial<VectorMetadata>): Promise<number> {
    const filter: Record<string, unknown> = {
      agentId: { $eq: agentId },
      ...Object.fromEntries(
        Object.entries(filters).map(([k, v]) => [k, { $eq: v }]),
      ),
    };

    // Pinecone delete by metadata filter
    await this.index.deleteMany({ filter });
    return -1; // Pinecone doesn't return count
  }

  async get(id: string): Promise<VectorRecord | null> {
    const result = await this.index.fetch([id]);
    const record = result.records?.[id];
    if (!record) return null;

    return {
      id,
      vector: record.values ?? [],
      content: (record.metadata?.content as string) ?? '',
      metadata: (record.metadata ?? {}) as unknown as VectorMetadata,
    };
  }

  async count(agentId: string): Promise<number> {
    const stats = await this.index.describeIndexStats();
    return stats.totalRecordCount ?? 0;
  }

  async cleanup(): Promise<number> {
    // Pinecone TTL cleanup would use metadata namespace filtering
    logger.warn('Pinecone TTL cleanup not implemented — use Pinecone TTL feature on index');
    return 0;
  }

  async close(): Promise<void> {
    this.index = null;
  }
}
