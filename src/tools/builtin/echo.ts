import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo back the input. Useful for testing.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to echo back' },
    },
    required: ['message'],
  },
  category: 'system',
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    return { content: String(params.message ?? '') };
  },
};

export default echoTool;
