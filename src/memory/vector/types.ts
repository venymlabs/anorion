// Vector Store Types — interfaces for RAG/semantic memory

/** A single vector record stored in the vector database */
export interface VectorRecord {
  id: string;
  /** The embedding vector */
  vector: Float32Array | number[];
  /** Original text that was embedded */
  content: string;
  /** Metadata for filtering and context */
  metadata: VectorMetadata;
  /** Similarity score (populated on search) */
  score?: number;
}

export interface VectorMetadata {
  /** Agent that owns this record */
  agentId: string;
  /** Source type: where this content came from */
  source: 'message' | 'document' | 'memory' | 'manual';
  /** Optional session ID (for message sources) */
  sessionId?: string;
  /** Original message/document ID */
  sourceId?: string;
  /** Content type of the original */
  contentType?: 'text' | 'markdown' | 'code' | 'pdf';
  /** Chunk index within the source document */
  chunkIndex?: number;
  /** When this record was created */
  createdAt: string;
  /** TTL in seconds from createdAt; 0 = no expiry */
  ttl: number;
  /** Importance score 0-1, affects retention and ranking */
  importance: number;
  /** Hash of content for deduplication */
  contentHash: string;
  /** Free-form tags for filtering */
  tags?: string[];
  /** File path for document sources */
  filePath?: string;
}

export interface VectorSearchResult {
  record: VectorRecord;
  score: number;
  /** Which search strategy found this result */
  matchType: 'vector' | 'keyword' | 'hybrid';
}

export interface VectorSearchQuery {
  /** Text to search for (will be embedded) */
  query: string;
  /** Agent scope */
  agentId: string;
  /** Maximum results */
  limit?: number;
  /** Minimum similarity threshold (0-1) */
  minScore?: number;
  /** Filter by source type */
  sourceType?: VectorMetadata['source'];
  /** Filter by session */
  sessionId?: string;
  /** Filter by tags */
  tags?: string[];
  /** Include keyword search results (hybrid mode) */
  hybrid?: boolean;
  /** Weight for vector vs keyword in hybrid: 0=keyword only, 1=vector only */
  vectorWeight?: number;
}

export interface VectorStoreConfig {
  /** Which adapter to use */
  adapter: 'sqlite-vec' | 'chroma' | 'pinecone';
  /** Embedding model string (provider/model format) */
  embeddingModel: string;
  /** Vector dimensions (auto-detected from model if not set) */
  dimensions?: number;
  /** Default TTL in seconds (0 = no expiry) */
  defaultTtl: number;
  /** Default importance for auto-ingested records */
  defaultImportance: number;
  /** Chunk size in characters */
  chunkSize: number;
  /** Overlap between chunks in characters */
  chunkOverlap: number;
  /** Maximum results for search */
  defaultSearchLimit: number;
  /** Adapter-specific options */
  adapterOptions?: Record<string, unknown>;
}

export const DEFAULT_VECTOR_CONFIG: VectorStoreConfig = {
  adapter: 'sqlite-vec',
  embeddingModel: 'openai/text-embedding-3-small',
  defaultTtl: 0,
  defaultImportance: 0.5,
  chunkSize: 512,
  chunkOverlap: 64,
  defaultSearchLimit: 10,
};

/** Adapter interface — all vector stores implement this */
export interface VectorStoreAdapter {
  /** Initialize the store (create tables, connect, etc.) */
  initialize(): Promise<void>;
  /** Insert or update a vector record */
  upsert(record: VectorRecord): Promise<void>;
  /** Batch insert/update */
  upsertBatch(records: VectorRecord[]): Promise<void>;
  /** Search by vector similarity */
  search(query: VectorSearchQuery, queryVector: number[]): Promise<VectorSearchResult[]>;
  /** Delete records by ID */
  delete(ids: string[]): Promise<void>;
  /** Delete records matching metadata filters */
  deleteByMetadata(agentId: string, filters: Partial<VectorMetadata>): Promise<number>;
  /** Get a record by ID */
  get(id: string): Promise<VectorRecord | null>;
  /** Count records for an agent */
  count(agentId: string): Promise<number>;
  /** Clean up expired records (TTL-based) */
  cleanup(): Promise<number>;
  /** Close connections */
  close(): Promise<void>;
}
