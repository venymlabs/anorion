import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

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

const fileWriteTool: ToolDefinition = {
  name: 'file-write',
  description: 'Write content to a file. Creates directories if needed. Paths are sandboxed to allowed directories.',
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

    const { ok, resolved } = isPathAllowed(filePath);
    if (!ok) {
      return { content: '', error: `Path not allowed (sandboxed): ${resolved}. Allowed paths: ${allowedPaths.join(', ')}` };
    }

    try {
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return { content: `Written ${content.length} bytes to ${resolved}` };
    } catch (err: unknown) {
      return { content: '', error: (err as Error).message };
    }
  },
};

export default fileWriteTool;
