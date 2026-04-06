// ChromaDB Adapter — optional vector store backed by ChromaDB
// Requires a running ChromaDB instance (local or cloud)

import type { VectorStoreAdapter, VectorRecord, VectorSearchResult, VectorSearchQuery, VectorMetadata } from '../types';
import { logger } from '../../../shared/logger';

export interface ChromaConfig {
  url: string;
  collectionName: string;
  apiKey?: string;
}

export class ChromaAdapter implements VectorStoreAdapter {
  private collection: any = null;

  constructor(private config: ChromaConfig) {}

  async initialize(): Promise<void> {
    // Dynamic import — fails gracefully if chromadb isn't installed
    let ChromaClient: any;
    try {
// @ts-expect-error -- chromadb types optional
      const mod = await import('chromadb');
      ChromaClient = mod.ChromaClient;
    } catch {
      throw new Error(
        'chromadb package not installed. Install with: bun add chromadb',
      );
    }

    const client = new ChromaClient({ path: this.config.url });
    if (this.config.apiKey) {
      client.auth({ token: this.config.apiKey });
    }

    this.collection = await client.getOrCreateCollection({
      name: this.config.collectionName,
    });

    logger.info({ collection: this.config.collectionName }, 'ChromaDB adapter initialized');
  }

  async upsert(record: VectorRecord): Promise<void> {
    await this.collection.upsert({
      ids: [record.id],
      embeddings: [Array.from(record.vector)],
      documents: [record.content],
      metadatas: [record.metadata],
    });
  }

  async upsertBatch(records: VectorRecord[]): Promise<void> {
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.collection.upsert({
        ids: batch.map((r) => r.id),
        embeddings: batch.map((r) => Array.from(r.vector)),
        documents: batch.map((r) => r.content),
        metadatas: batch.map((r) => r.metadata as unknown as Record<string, unknown>),
      });
    }
  }

  async search(query: VectorSearchQuery, queryVector: number[]): Promise<VectorSearchResult[]> {
    const where: Record<string, unknown> = { agentId: query.agentId };
    if (query.sourceType) where.source = query.sourceType;
    if (query.sessionId) where.sessionId = query.sessionId;

    const result = await this.collection.query({
      queryEmbeddings: [queryVector],
      nResults: query.limit ?? 10,
      where,
      include: ['documents', 'metadatas', 'distances'],
    });

    const results: VectorSearchResult[] = [];
    const ids = result.ids[0] ?? [];
    const docs = result.documents[0] ?? [];
    const metas = result.metadatas[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const distance = distances[i] ?? 1;
      // ChromaDB returns L2 distance; convert to similarity score
      const score = 1 / (1 + distance);
      if (score >= (query.minScore ?? 0.5)) {
        results.push({
          record: {
            id: ids[i],
            vector: [],
            content: docs[i] ?? '',
            metadata: metas[i] as VectorMetadata,
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
      await this.collection.delete({ ids });
    }
  }

  async deleteByMetadata(agentId: string, filters: Partial<VectorMetadata>): Promise<number> {
    const where: Record<string, unknown> = { agentId, ...filters };
    const existing = await this.collection.get({ where });
    const ids = existing.ids;
    if (ids.length > 0) {
      await this.collection.delete({ ids });
    }
    return ids.length;
  }

  async get(id: string): Promise<VectorRecord | null> {
    const result = await this.collection.get({
      ids: [id],
      include: ['documents', 'metadatas', 'embeddings'],
    });
    if (!result.ids.length) return null;

    return {
      id: result.ids[0],
      vector: result.embeddings?.[0] ?? [],
      content: result.documents?.[0] ?? '',
      metadata: result.metadatas?.[0] as VectorMetadata,
    };
  }

  async count(agentId: string): Promise<number> {
    return await this.collection.count();
  }

  async cleanup(): Promise<number> {
    // ChromaDB TTL cleanup would need to be done via metadata filtering
    const now = new Date();
    const all = await this.collection.get({
      where: { ttl: { $gt: 0 } },
      include: ['metadatas'],
    });

    const expired: string[] = [];
    for (let i = 0; i < all.ids.length; i++) {
      const meta = all.metadatas[i] as VectorMetadata;
      if (meta.ttl > 0 && meta.createdAt) {
        const expires = new Date(meta.createdAt).getTime() + meta.ttl * 1000;
        if (now.getTime() > expires) {
          expired.push(all.ids[i]);
        }
      }
    }

    if (expired.length > 0) {
      await this.delete(expired);
    }
    return expired.length;
  }

  async close(): Promise<void> {
    this.collection = null;
  }
}
