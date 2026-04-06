import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { memoryManager, type MemoryCategory } from '../../memory/store';
import { logger } from '../../shared/logger';

const VALID_CATEGORIES: MemoryCategory[] = ['identity', 'preference', 'fact', 'lesson', 'context'];

export const memorySaveTool: ToolDefinition = {
  name: 'memory-save',
  description: 'Save a memory entry for later recall. Use this to remember important facts, preferences, or context.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short identifier for the memory' },
      value: { type: 'string', description: 'The content to remember' },
      category: {
        type: 'string',
        enum: VALID_CATEGORIES,
        description: 'Category: identity (who), preference (likes/dislikes), fact (things known), lesson (learned rules), context (situational)',
      },
    },
    required: ['key', 'value'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const { key, value, category } = params;
    if (!key || !value) return { content: 'Error: key and value are required', error: 'missing fields' };

    const cat = (VALID_CATEGORIES.includes(category as MemoryCategory) ? category : 'fact') as MemoryCategory;
    const entry = memoryManager.save(ctx.agentId, cat, String(key), String(value));
    return { content: `Memory saved: [${entry.category}] ${entry.key}` };
  },
};

export const memorySearchTool: ToolDefinition = {
  name: 'memory-search',
  description: 'Search through saved memories by keyword.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms' },
    },
    required: ['query'],
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const results = memoryManager.search(ctx.agentId, String(params.query || ''));
    if (results.length === 0) return { content: 'No matching memories found.' };
    const lines = results.map((r) => `[${r.category}] ${r.key}: ${typeof r.value === 'string' ? r.value : JSON.stringify(r.value)}`);
    return { content: lines.join('\n') };
  },
};

export const memoryListTool: ToolDefinition = {
  name: 'memory-list',
  description: 'List all saved memories, optionally filtered by category.',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: VALID_CATEGORIES, description: 'Optional category filter' },
    },
  },
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    let entries;
    if (params.category && VALID_CATEGORIES.includes(params.category as MemoryCategory)) {
      entries = memoryManager.loadByCategory(ctx.agentId, params.category as MemoryCategory);
    } else {
      entries = memoryManager.load(ctx.agentId);
    }
    if (entries.length === 0) return { content: 'No memories saved.' };
    const lines = entries.map((e) => `[${e.category}] ${e.key}: ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`);
    return { content: lines.join('\n') };
  },
};
