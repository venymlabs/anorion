// Vector Memory Tools — semantic_search, ingest_document, query_memory

import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { getVectorMemory } from '../../memory/vector';
import { logger } from '../../shared/logger';

export const semanticSearchTool: ToolDefinition = {
  name: 'semantic-search',
  description:
    'Search for semantically similar content across conversations, documents, and memories. ' +
    'Uses vector embeddings to find conceptually related information, not just keyword matches.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query to search for semantically similar content',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default: 5)',
        default: 5,
      },
      min_score: {
        type: 'number',
        description: 'Minimum relevance score 0-1 (default: 0.5)',
        default: 0.5,
      },
      source_type: {
        type: 'string',
        enum: ['message', 'document', 'memory', 'manual'],
        description: 'Filter results to a specific source type',
      },
    },
    required: ['query'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const vm = getVectorMemory();
    if (!vm) return { content: 'Vector memory is not initialized. Enable it in config to use semantic search.' };

    try {
      const results = await vm.search(
        String(params.query),
        ctx.agentId,
        {
          limit: (params.limit as number) ?? 5,
          minScore: (params.min_score as number) ?? 0.5,
          sourceType: params.source_type as any,
        },
      );

      if (results.length === 0) {
        return { content: 'No semantically similar content found.' };
      }

      const lines = results.map((r, i) => {
        const meta = r.record.metadata;
        const source = meta.source === 'message'
          ? 'Conversation'
          : meta.source === 'document'
            ? `Doc: ${meta.filePath ?? meta.sourceId ?? 'unknown'}`
            : meta.source === 'memory'
              ? 'Memory'
              : 'Manual';
        return `${i + 1}. [${source}] (score: ${(r.score * 100).toFixed(0)}%, ${r.matchType} match)\n   ${r.record.content.slice(0, 300)}${r.record.content.length > 300 ? '...' : ''}`;
      });

      return { content: lines.join('\n\n') };
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Semantic search tool failed');
      return { content: `Search error: ${(err as Error).message}`, error: 'search_failed' };
    }
  },
};

export const ingestDocumentTool: ToolDefinition = {
  name: 'ingest-document',
  description:
    'Ingest a document or text content into the vector memory for semantic search. ' +
    'Supports file paths or direct text content. Content is chunked and embedded automatically.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to ingest',
      },
      content: {
        type: 'string',
        description: 'Direct text content to ingest (alternative to file_path)',
      },
      content_type: {
        type: 'string',
        enum: ['text', 'markdown', 'code'],
        description: 'Content type hint for better chunking',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to associate with this content',
      },
      importance: {
        type: 'number',
        description: 'Importance score 0-1 (default: 0.5)',
        default: 0.5,
      },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const vm = getVectorMemory();
    if (!vm) return { content: 'Vector memory is not initialized.' };

    if (!params.file_path && !params.content) {
      return { content: 'Error: provide either file_path or content', error: 'missing_params' };
    }

    try {
      const result = await vm.ingest({
        agentId: ctx.agentId,
        filePath: params.file_path as string | undefined,
        content: params.content as string | undefined,
        contentType: params.content_type as any,
        tags: params.tags as string[] | undefined,
        importance: params.importance as number | undefined,
      });

      return {
        content: `Ingested: ${result.chunks} chunks, ${result.vectors} vectors, ~${result.tokens} tokens (${result.durationMs}ms)`,
      };
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Document ingestion failed');
      return { content: `Ingestion error: ${(err as Error).message}`, error: 'ingestion_failed' };
    }
  },
};

export const queryMemoryTool: ToolDefinition = {
  name: 'query-memory',
  description:
    'Query the RAG (Retrieval-Augmented Generation) memory system. ' +
    'Retrieves relevant context from conversations, documents, and memories, ' +
    'then returns an augmented prompt with the retrieved information. ' +
    'Use this when you need to ground a response in past knowledge.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The question or topic to retrieve context for',
      },
      max_context_tokens: {
        type: 'integer',
        description: 'Maximum tokens for retrieved context (default: 4000)',
        default: 4000,
      },
      include_messages: {
        type: 'boolean',
        description: 'Include past conversation messages in search (default: true)',
        default: true,
      },
      include_documents: {
        type: 'boolean',
        description: 'Include ingested documents in search (default: true)',
        default: true,
      },
    },
    required: ['query'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const vm = getVectorMemory();
    if (!vm) return { content: 'Vector memory is not initialized.' };

    try {
      const sourceTypes: Array<'message' | 'document' | 'memory' | 'manual'> = ['memory'];
      if (params.include_messages !== false) sourceTypes.push('message');
      if (params.include_documents !== false) sourceTypes.push('document', 'manual');

      const result = await vm.query({
        query: String(params.query),
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        maxContextTokens: (params.max_context_tokens as number) ?? 4000,
        sourceTypes,
      });

      if (result.sources.length === 0) {
        return { content: 'No relevant context found in memory.' };
      }

      const sourceList = result.sources
        .slice(0, 5)
        .map((s, i) => `${i + 1}. [${s.record.metadata.source}] ${(s.score * 100).toFixed(0)}% relevant`)
        .join('\n');

      return {
        content: `Retrieved ${result.sources.length} sources (${result.contextTokens} tokens${result.truncated ? ', truncated' : ''}):\n${sourceList}\n\n---\n\n${result.augmentedPrompt.split('[Retrieved Context]')[1]?.split('[End Retrieved Context]')[0]?.trim() ?? 'No context available.'}`,
      };
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Query memory tool failed');
      return { content: `Query error: ${(err as Error).message}`, error: 'query_failed' };
    }
  },
};
