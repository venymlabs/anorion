// Vector Memory — RAG/semantic search module
// Wires together: adapter, embeddings, search, ingestion, RAG pipeline, management

import type { Database } from 'bun:sqlite';
import type { VectorStoreConfig, VectorStoreAdapter } from './types';
import { DEFAULT_VECTOR_CONFIG } from './types';
import { SqliteVecAdapter } from './adapters/sqlite-vec';
import { ChromaAdapter, type ChromaConfig } from './adapters/chroma';
import { PineconeAdapter, type PineconeConfig } from './adapters/pinecone';
import { SemanticSearch } from './search';
import { DocumentIngester, type IngestOptions, type IngestResult } from './ingest';
import { RagPipeline, type RagQuery, type RagResult } from './rag';
import { MemoryManager } from './management';
import { detectDimensions } from './embeddings';
import { logger } from '../../shared/logger';

export type { VectorStoreConfig, VectorRecord, VectorMetadata, VectorSearchQuery, VectorSearchResult } from './types';
export type { ChromaConfig } from './adapters/chroma';
export type { PineconeConfig } from './adapters/pinecone';
export type { IngestOptions, IngestResult } from './ingest';
export type { RagQuery, RagResult } from './rag';

export class VectorMemory {
  private adapter: VectorStoreAdapter;
  private searchEngine: SemanticSearch;
  ingester: DocumentIngester;
  rag: RagPipeline;
  management: MemoryManager;
  private initialized = false;

  constructor(
    private config: VectorStoreConfig,
    private db?: Database,
  ) {
    this.adapter = this.createAdapter();
    this.searchEngine = new SemanticSearch(this.adapter, this.config);
    this.ingester = new DocumentIngester(this.adapter, this.config);
    this.rag = new RagPipeline(this.searchEngine, this.config);
    this.management = new MemoryManager(this.adapter, this.config);
  }

  /** Initialize the vector store (must be called before use) */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Auto-detect dimensions if not set
    if (!this.config.dimensions) {
      try {
        this.config.dimensions = await detectDimensions(this.config.embeddingModel);
        logger.info({ dimensions: this.config.dimensions }, 'Auto-detected embedding dimensions');
      } catch (err) {
        // Default to common dimension sizes
        this.config.dimensions = 1536;
        logger.warn({ error: (err as Error).message }, 'Using default dimensions (1536)');
      }
    }

    await this.adapter.initialize();

    // Start periodic cleanup (hourly)
    this.management.startCleanup(3600);

    this.initialized = true;
    logger.info({ adapter: this.config.adapter }, 'Vector memory initialized');
  }

  /** Semantic search */
  async search(query: string, agentId: string, options?: {
    limit?: number;
    minScore?: number;
    sourceType?: VectorMetadata['source'];
    sessionId?: string;
  }) {
    return this.searchEngine.search({ query, agentId, ...options });
  }

  /** Ingest a document */
  async ingest(options: IngestOptions): Promise<IngestResult> {
    return this.ingester.ingest(options);
  }

  /** Ingest a message for semantic memory */
  async ingestMessage(
    agentId: string,
    sessionId: string,
    messageId: string,
    content: string,
    role: string,
  ): Promise<void> {
    return this.ingester.ingestMessage(agentId, sessionId, messageId, content, role);
  }

  /** Run RAG pipeline */
  async query(query: RagQuery): Promise<RagResult> {
    return this.rag.run(query);
  }

  /** Get the underlying adapter for advanced operations */
  getAdapter(): VectorStoreAdapter {
    return this.adapter;
  }

  /** Shutdown cleanly */
  async close(): Promise<void> {
    this.management.stopCleanup();
    await this.adapter.close();
    this.initialized = false;
  }

  private createAdapter(): VectorStoreAdapter {
    switch (this.config.adapter) {
      case 'sqlite-vec': {
        if (!this.db) {
          throw new Error('SQLite-vec adapter requires a Database instance');
        }
        return new SqliteVecAdapter(this.db, {
          dimensions: this.config.dimensions ?? 1536,
        });
      }
      case 'chroma': {
        const chromaConfig = (this.config.adapterOptions ?? {}) as Partial<ChromaConfig>;
        return new ChromaAdapter({
          url: chromaConfig.url ?? 'http://localhost:8000',
          collectionName: chromaConfig.collectionName ?? 'anorion_vectors',
          apiKey: chromaConfig.apiKey,
        });
      }
      case 'pinecone': {
        const pineconeConfig = (this.config.adapterOptions ?? {}) as Partial<PineconeConfig>;
        if (!pineconeConfig.apiKey) {
          throw new Error('Pinecone adapter requires apiKey in adapterOptions');
        }
        return new PineconeAdapter({
          apiKey: pineconeConfig.apiKey,
          indexName: pineconeConfig.indexName ?? 'anorion',
          environment: pineconeConfig.environment,
        });
      }
      default:
        throw new Error(`Unknown vector adapter: ${this.config.adapter}`);
    }
  }
}

// Re-export VectorMetadata for convenience
import type { VectorMetadata } from './types';

/** Singleton — set via initVectorMemory() */
let vectorMemory: VectorMemory | null = null;

/** Initialize the global vector memory instance */
export async function initVectorMemory(
  config: Partial<VectorStoreConfig>,
  db: Database,
): Promise<VectorMemory> {
  const merged = { ...DEFAULT_VECTOR_CONFIG, ...config };
  vectorMemory = new VectorMemory(merged, db);
  await vectorMemory.initialize();
  return vectorMemory;
}

/** Get the global vector memory instance */
export function getVectorMemory(): VectorMemory | null {
  return vectorMemory;
}
