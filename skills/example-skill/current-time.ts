import type { ToolDefinition, ToolResult } from '../../src/shared/types';

const config = { timezone: 'UTC' };

export function configure(cfg: Record<string, unknown>) {
  Object.assign(config, cfg);
}

const currentTimeTool: ToolDefinition = {
  name: 'current-time',
  description: 'Get the current date and time in the configured timezone.',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', description: 'Output format: iso, unix, or readable (default: readable)' },
    },
  },
  category: 'utility',
  timeoutMs: 1000,
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const now = new Date();
    const format = String(params.format || 'readable');
    switch (format) {
      case 'unix':
        return { content: String(Math.floor(now.getTime() / 1000)) };
      case 'iso':
        return { content: now.toISOString() };
      default:
        return { content: now.toLocaleString('en-US', { timeZone: config.timezone }) };
    }
  },
};

export default currentTimeTool;
