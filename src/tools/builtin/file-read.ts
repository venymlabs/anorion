import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { readFileSync, existsSync } from 'fs';

const fileReadTool: ToolDefinition = {
  name: 'file-read',
  description: 'Read a file. Returns content with optional line limits.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
    required: ['path'],
  },
  category: 'filesystem',
  timeoutMs: 5000,
  maxOutputBytes: 500_000,
  execute: async (params): Promise<ToolResult> => {
    const filePath = String(params.path);

    if (!existsSync(filePath)) {
      return { content: '', error: `File not found: ${filePath}` };
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const offset = Number(params.offset) || 1;
      const limit = Number(params.limit) || lines.length;

      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      const result = sliced.join('\n');

      const truncated = sliced.length < lines.length;
      return {
        content: result + (truncated ? `\n\n[Showing lines ${offset}-${offset + sliced.length - 1} of ${lines.length}]` : ''),
      };
    } catch (err: unknown) {
      return { content: '', error: (err as Error).message };
    }
  },
};

export default fileReadTool;
