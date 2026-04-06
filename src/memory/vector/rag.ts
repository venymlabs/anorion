// RAG Pipeline — retrieve, rerank, and inject context into prompts

import type { VectorSearchResult, VectorStoreConfig } from './types';
import { SemanticSearch } from './search';
import { logger } from '../../shared/logger';

export interface RagQuery {
  /** The user's query text */
  query: string;
  /** Agent ID for scoping */
  agentId: string;
  /** Optional session ID */
  sessionId?: string;
  /** System prompt to inject context into */
  systemPrompt?: string;
  /** Maximum tokens for retrieved context */
  maxContextTokens?: number;
  /** Minimum relevance score to include */
  minScore?: number;
  /** Filter to specific source types */
  sourceTypes?: Array<'message' | 'document' | 'memory' | 'manual'>;
}

export interface RagResult {
  /** The augmented system prompt with injected context */
  augmentedPrompt: string;
  /** The retrieved and ranked sources */
  sources: VectorSearchResult[];
  /** Total tokens used in context */
  contextTokens: number;
  /** Whether context was truncated */
  truncated: boolean;
}

export class RagPipeline {
  private search: SemanticSearch;

  constructor(
    search: SemanticSearch,
    private config: VectorStoreConfig,
  ) {
    this.search = search;
  }

  /** Run the full RAG pipeline: retrieve → rerank → augment */
  async run(query: RagQuery): Promise<RagResult> {
    const start = Date.now();

    // 1. Retrieve from all relevant source types
    const allResults: VectorSearchResult[] = [];

    const sourceTypes = query.sourceTypes ?? ['memory', 'document', 'message', 'manual'];
    for (const sourceType of sourceTypes) {
      try {
        const results = await this.search.search({
          query: query.query,
          agentId: query.agentId,
          sourceType,
          sessionId: query.sessionId,
          limit: this.config.defaultSearchLimit,
          minScore: query.minScore ?? 0.4,
        });
        allResults.push(...results);
      } catch (err) {
        logger.debug({ sourceType, error: (err as Error).message }, 'RAG source search failed');
      }
    }

    // 2. Rerank by composite score: similarity * importance boost
    const ranked = this.rerank(allResults);

    // 3. Select within token budget
    const maxTokens = query.maxContextTokens ?? 4000;
    const { selected, usedTokens, truncated } = this.selectWithinBudget(ranked, maxTokens);

    // 4. Augment the system prompt
    const contextBlock = this.buildContextBlock(selected);
    const augmentedPrompt = this.augmentPrompt(query.systemPrompt ?? '', contextBlock);

    const duration = Date.now() - start;
    logger.debug({
      query: query.query.slice(0, 100),
      results: allResults.length,
      selected: selected.length,
      tokens: usedTokens,
      durationMs: duration,
    }, 'RAG pipeline completed');

    return {
      augmentedPrompt,
      sources: selected,
      contextTokens: usedTokens,
      truncated,
    };
  }

  /** Rerank results using importance-weighted scoring */
  private rerank(results: VectorSearchResult[]): VectorSearchResult[] {
    return results
      .map((r) => {
        const importance = r.record.metadata.importance ?? 0.5;
        // Boost by importance: score * (0.5 + 0.5 * importance)
        const boostedScore = r.score * (0.5 + 0.5 * importance);
        return { ...r, score: boostedScore };
      })
      // Deduplicate by record ID (keep highest score)
      .reduce((map, r) => {
        const existing = map.get(r.record.id);
        if (!existing || existing.score < r.score) {
          map.set(r.record.id, r);
        }
        return map;
      }, new Map<string, VectorSearchResult>())
      .values()
      .toArray()
      .sort((a, b) => b.score - a.score);
  }

  /** Select results that fit within the token budget */
  private selectWithinBudget(
    results: VectorSearchResult[],
    maxTokens: number,
  ): { selected: VectorSearchResult[]; usedTokens: number; truncated: boolean } {
    let usedTokens = 0;
    const selected: VectorSearchResult[] = [];

    for (const r of results) {
      const estTokens = Math.ceil(r.record.content.length / 4);
      if (usedTokens + estTokens > maxTokens) {
        return { selected, usedTokens, truncated: true };
      }
      usedTokens += estTokens;
      selected.push(r);
    }

    return { selected, usedTokens, truncated: false };
  }

  /** Build a context block from selected results */
  private buildContextBlock(results: VectorSearchResult[]): string {
    if (results.length === 0) return '';

    const parts = results.map((r) => {
      const meta = r.record.metadata;
      const source = meta.source === 'message'
        ? `conversation`
        : meta.source === 'document'
          ? `document: ${meta.filePath ?? meta.sourceId ?? 'unknown'}`
          : meta.source;

      return `[${source} (relevance: ${(r.score * 100).toFixed(0)}%)]\n${r.record.content}`;
    });

    return parts.join('\n\n---\n\n');
  }

  /** Augment the system prompt with retrieved context */
  private augmentPrompt(systemPrompt: string, contextBlock: string): string {
    if (!contextBlock) return systemPrompt;

    const contextSection = `\n\n[Retrieved Context]\nThe following information was retrieved from memory and may be relevant to the user's query:\n\n${contextBlock}\n\n[End Retrieved Context]`;

    if (systemPrompt) {
      return systemPrompt + contextSection;
    }

    return `You are a helpful assistant.${contextSection}`;
  }
}
