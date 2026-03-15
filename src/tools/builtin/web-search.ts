import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { logger } from '../../shared/logger';

const webSearchTool: ToolDefinition = {
  name: 'web-search',
  description: 'Search the web. (Placeholder — Brave API integration coming soon.)',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  category: 'search',
  timeoutMs: 5000,
  execute: async (params): Promise<ToolResult> => {
    logger.info({ query: params.query }, 'Web search requested (not yet configured)');
    return { content: 'Web search is not yet configured. Configure a Brave API key to enable searching.' };
  },
};

export default webSearchTool;
