import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const fileWriteTool: ToolDefinition = {
  name: 'file-write',
  description: 'Write content to a file. Creates directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  category: 'filesystem',
  timeoutMs: 5000,
  execute: async (params): Promise<ToolResult> => {
    const filePath = String(params.path);
    const content = String(params.content);

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
      return { content: `Written ${content.length} bytes to ${filePath}` };
    } catch (err: unknown) {
      return { content: '', error: (err as Error).message };
    }
  },
};

export default fileWriteTool;
