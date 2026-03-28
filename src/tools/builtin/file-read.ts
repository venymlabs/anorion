import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

// Configurable allowed paths (default: current working directory)
const DEFAULT_ALLOWED_PATHS = [process.cwd()];
const allowedPaths: string[] = (globalThis as any).__SANDBOX_ALLOWED_PATHS || DEFAULT_ALLOWED_PATHS;

function isPathAllowed(inputPath: string): { ok: boolean; resolved: string } {
  const resolved = resolve(inputPath);

  // Block path traversal
  if (inputPath.includes('..')) {
    return { ok: false, resolved };
  }

  for (const allowed of allowedPaths) {
    const allowedResolved = resolve(allowed);
    if (resolved.startsWith(allowedResolved + '/') || resolved === allowedResolved) {
      return { ok: true, resolved };
    }
  }

  return { ok: false, resolved };
}

export function setAllowedPaths(paths: string[]) {
  allowedPaths.length = 0;
  allowedPaths.push(...paths);
}

const fileReadTool: ToolDefinition = {
  name: 'file-read',
  description: 'Read a file. Returns content with optional line limits. Paths are sandboxed to allowed directories.',
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

    const { ok, resolved } = isPathAllowed(filePath);
    if (!ok) {
      return { content: '', error: `Path not allowed (sandboxed): ${resolved}. Allowed paths: ${allowedPaths.join(', ')}` };
    }

    if (!existsSync(resolved)) {
      return { content: '', error: `File not found: ${resolved}` };
    }

    try {
      const content = readFileSync(resolved, 'utf-8');
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
