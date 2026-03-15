import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);

const shellTool: ToolDefinition = {
  name: 'shell',
  description: 'Execute a shell command. Use with caution — this can run arbitrary commands.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      cwd: { type: 'string', description: 'Working directory' },
    },
    required: ['command'],
  },
  category: 'system',
  timeoutMs: 60000,
  execute: async (params, _ctx): Promise<ToolResult> => {
    const command = String(params.command);
    const timeout = Number(params.timeout) || 30000;
    const cwd = params.cwd ? String(params.cwd) : undefined;

    try {
      const { stdout, stderr } = await execAsync(command, { timeout, cwd, maxBuffer: 1024 * 1024 });
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return { content: output || '(no output)' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const output = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n');
      const msg = e.killed ? `Command timed out after ${timeout}ms` : (e.message || 'Unknown error');
      return { content: output || '', error: msg };
    }
  },
};

export default shellTool;
