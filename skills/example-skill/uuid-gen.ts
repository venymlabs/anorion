import type { ToolDefinition, ToolResult } from '../../src/shared/types';

const uuidGenTool: ToolDefinition = {
  name: 'uuid-gen',
  description: 'Generate one or more UUIDs.',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of UUIDs to generate (default: 1, max: 100)' },
    },
  },
  category: 'utility',
  timeoutMs: 1000,
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const count = Math.min(Number(params.count) || 1, 100);
    const uuids = Array.from({ length: count }, () => crypto.randomUUID());
    return { content: uuids.join('\n') };
  },
};

export default uuidGenTool;
