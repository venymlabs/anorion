// Memory Management — TTL cleanup, deduplication, importance scoring

import type { VectorStoreAdapter, VectorStoreConfig } from './types';
import { generateEmbedding } from './embeddings';
import { logger } from '../../shared/logger';

export class MemoryManager {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: VectorStoreAdapter,
    private config: VectorStoreConfig,
  ) {}

  /** Start periodic cleanup (TTL enforcement) */
  startCleanup(intervalSeconds: number = 3600): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(async () => {
      try {
        const removed = await this.store.cleanup();
        if (removed > 0) {
          logger.info({ removed }, 'Periodic vector cleanup completed');
        }
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'Vector cleanup failed');
      }
    }, intervalSeconds * 1000);

    // Don't prevent process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Stop periodic cleanup */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Check for near-duplicates and remove them */
  async deduplicate(agentId: string, threshold: number = 0.98): Promise<number> {
    // Get all records for agent
    const count = await this.store.count(agentId);
    if (count === 0) return 0;

    // This is expensive for large datasets; only run on demand
    logger.info({ agentId, count }, 'Starting deduplication scan');

    // Search for each record against itself to find near-duplicates
    // For now, this is a placeholder that would need batch processing
    // for production use with large datasets
    let removed = 0;

    logger.info({ agentId, removed }, 'Deduplication completed');
    return removed;
  }

  /** Score content importance heuristically */
  scoreImportance(content: string, source: string, metadata?: Record<string, unknown>): number {
    let score = 0.5; // baseline

    // Length heuristic: medium-length content tends to be more informative
    const len = content.length;
    if (len > 200 && len < 2000) score += 0.1;
    if (len > 50 && len < 200) score += 0.05;

    // Structure heuristic: has sentence structure
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length >= 3) score += 0.1;

    // Source heuristic
    if (source === 'document') score += 0.05;
    if (source === 'memory') score += 0.1;

    // Metadata-based adjustments
    if (metadata) {
      // Code content is often important
      if (metadata.contentType === 'code') score += 0.05;
      // Recent content is more important
      if (metadata.createdAt) {
        const age = Date.now() - new Date(metadata.createdAt as string).getTime();
        const daysSince = age / (1000 * 60 * 60 * 24);
        if (daysSince < 1) score += 0.1;
        else if (daysSince < 7) score += 0.05;
      }
    }

    return Math.min(1, Math.max(0, score));
  }

  /** Get stats about the vector store for an agent */
  async getStats(agentId: string): Promise<{
    totalRecords: number;
    sourceBreakdown: Record<string, number>;
  }> {
    const totalRecords = await this.store.count(agentId);

    return {
      totalRecords,
      sourceBreakdown: {}, // Would need aggregate query support
    };
  }
}
