// Document Ingestion — read files, chunk, embed, and store

import type { BunFile } from 'bun';
import type { VectorStoreAdapter, VectorRecord, VectorMetadata, VectorStoreConfig } from './types';
import { autoChunk, type Chunk } from './chunker';
import { generateEmbedding, generateEmbeddings } from './embeddings';
import { logger } from '../../shared/logger';

export interface IngestOptions {
  /** Agent to associate the document with */
  agentId: string;
  /** File path or content to ingest */
  filePath?: string;
  /** Direct content (if no file) */
  content?: string;
  /** Content type hint */
  contentType?: 'text' | 'markdown' | 'code' | 'pdf';
  /** Source label */
  sourceLabel?: string;
  /** Tags */
  tags?: string[];
  /** TTL in seconds */
  ttl?: number;
  /** Importance score (0-1) */
  importance?: number;
  /** Batch size for embedding generation */
  batchSize?: number;
}

export interface IngestResult {
  /** Number of chunks created */
  chunks: number;
  /** Number of vectors stored */
  vectors: number;
  /** Total estimated tokens */
  tokens: number;
  /** Duration in ms */
  durationMs: number;
}

export class DocumentIngester {
  constructor(
    private store: VectorStoreAdapter,
    private config: VectorStoreConfig,
  ) {}

  /** Ingest a document (file or direct content) */
  async ingest(options: IngestOptions): Promise<IngestResult> {
    const start = Date.now();

    // Read content
    let content: string;
    let contentType = options.contentType;
    let filePath = options.filePath;

    if (options.filePath) {
      content = await this.readFile(options.filePath, options.contentType);
      if (!contentType) {
        contentType = this.detectContentType(options.filePath);
      }
    } else if (options.content) {
      content = options.content;
      if (!contentType) contentType = 'text';
    } else {
      throw new Error('Ingest requires either filePath or content');
    }

    // Chunk
    const chunks = autoChunk(content, {
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
    }, contentType === 'pdf' ? 'text' : contentType);

    if (chunks.length === 0) {
      return { chunks: 0, vectors: 0, tokens: 0, durationMs: Date.now() - start };
    }

    // Generate embeddings in batches
    const batchSize = options.batchSize ?? 20;
    const records: VectorRecord[] = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await generateEmbeddings(texts, this.config.embeddingModel);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const embedding = embeddings[j]!;

        records.push({
          id: this.makeId(options.agentId, filePath ?? options.sourceLabel ?? 'content', chunk.index),
          vector: embedding.vector,
          content: chunk.content,
          metadata: {
            agentId: options.agentId,
            source: filePath ? 'document' : 'manual',
            sourceId: options.sourceLabel ?? filePath,
            contentType: contentType,
            chunkIndex: chunk.index,
            createdAt: new Date().toISOString(),
            ttl: options.ttl ?? this.config.defaultTtl,
            importance: options.importance ?? this.config.defaultImportance,
            contentHash: this.hashContent(chunk.content),
            tags: options.tags,
            filePath: filePath,
          },
        });
      }
    }

    // Store
    await this.store.upsertBatch(records);

    const duration = Date.now() - start;
    const totalTokens = chunks.reduce((sum, c) => sum + c.estimatedTokens, 0);

    logger.info({
      agentId: options.agentId,
      file: filePath ?? options.sourceLabel,
      chunks: chunks.length,
      vectors: records.length,
      tokens: totalTokens,
      durationMs: duration,
    }, 'Document ingested');

    return {
      chunks: chunks.length,
      vectors: records.length,
      tokens: totalTokens,
      durationMs: duration,
    };
  }

  /** Ingest a single message for semantic memory */
  async ingestMessage(
    agentId: string,
    sessionId: string,
    messageId: string,
    content: string,
    role: string,
  ): Promise<void> {
    if (!content.trim()) return;

    const { vector } = await generateEmbedding(content, this.config.embeddingModel);
    const record: VectorRecord = {
      id: `msg:${messageId}`,
      vector,
      content,
      metadata: {
        agentId,
        source: 'message',
        sessionId,
        sourceId: messageId,
        contentType: 'text',
        chunkIndex: 0,
        createdAt: new Date().toISOString(),
        ttl: this.config.defaultTtl,
        importance: role === 'system' ? 0.9 : role === 'assistant' ? 0.7 : 0.5,
        contentHash: this.hashContent(content),
      },
    };

    await this.store.upsert(record);
  }

  private async readFile(path: string, contentType?: string): Promise<string> {
    if (contentType === 'pdf' || path.endsWith('.pdf')) {
      // For PDF, try to use Bun's built-in PDF reader or fall back
      throw new Error('PDF ingestion requires a PDF parser. Use contentType="text" with pre-extracted text.');
    }

    const file = Bun.file(path);
    return await file.text();
  }

  private detectContentType(path: string): 'text' | 'markdown' | 'code' {
    if (path.endsWith('.md') || path.endsWith('.mdx')) return 'markdown';
    if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|rb|php|cs|swift|kt)$/.test(path)) return 'code';
    return 'text';
  }

  private makeId(agentId: string, source: string, chunkIndex: number): string {
    const hash = this.hashContent(`${agentId}:${source}:${chunkIndex}`);
    return `doc:${hash.slice(0, 16)}`;
  }

  private hashContent(content: string): string {
    // Simple fast hash for deduplication
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit int
    }
    return Math.abs(hash).toString(36);
  }
}
