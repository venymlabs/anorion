import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { resolve } from 'path';

// Configurable blocked commands
const DEFAULT_BLOCKED_COMMANDS = ['rm -rf /', 'mkfs', 'dd if='];
const blockedCommands: string[] = [...DEFAULT_BLOCKED_COMMANDS];

// Configurable allowed directories for cwd
const DEFAULT_ALLOWED_DIRS: string[] = [];
let allowedDirectories: string[] = [...DEFAULT_ALLOWED_DIRS];

export function setBlockedCommands(commands: string[]) {
  blockedCommands.length = 0;
  blockedCommands.push(...commands);
}

export function setAllowedDirectories(dirs: string[]) {
  allowedDirectories = dirs.map(d => resolve(d));
}

function isCommandBlocked(command: string): boolean {
  const lowerCmd = command.toLowerCase().trim();
  return blockedCommands.some(blocked => lowerCmd.includes(blocked.toLowerCase()));
}

function isCwdAllowed(cwd: string | undefined): boolean {
  if (!cwd || allowedDirectories.length === 0) return true; // no cwd or no restrictions
  const resolved = resolve(cwd);
  return allowedDirectories.some(allowed => resolved.startsWith(allowed + '/') || resolved === allowed);
}

const shellTool: ToolDefinition = {
  name: 'shell',
  description: 'Execute a shell command. Certain dangerous commands are blocked. cwd can be restricted to allowed directories.',
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

    // Check blocked commands
    if (isCommandBlocked(command)) {
      return { content: '', error: `Command blocked (sandboxed): "${command}"` };
    }

    // Check allowed directories for cwd
    if (cwd && !isCwdAllowed(cwd)) {
      return { content: '', error: `Working directory not allowed (sandboxed): ${cwd}` };
    }

    try {
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await Promise.race([
        proc.exited,
        new Promise<null>((_, reject) => setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, timeout)),
      ]);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

      if (exitCode === null) {
        return { content: output, error: `Command timed out after ${timeout}ms` };
      }
      if (exitCode !== 0) {
        return { content: output || '', error: `Exit code ${exitCode}` };
      }
      return { content: output || '(no output)' };
    } catch (err: unknown) {
      const e = err as { message?: string };
      if (e.message === 'timeout') {
        return { content: '', error: `Command timed out after ${timeout}ms` };
      }
      return { content: '', error: e.message || 'Unknown error' };
    }
  },
};

export default shellTool;
