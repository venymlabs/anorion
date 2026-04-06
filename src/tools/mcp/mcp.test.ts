import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { nextRequestId, createRequest, createNotification, parseMessage, isResponse, isNotification } from './json-rpc';
import { mcpToolId, adaptMcpTool } from './adapter';
import type { McpTool, McpContent } from './types';
import type { McpClient } from './client';

// ── JSON-RPC Tests ──

describe('json-rpc', () => {
  test('nextRequestId increments', () => {
    const id1 = nextRequestId();
    const id2 = nextRequestId();
    expect(id2).toBeGreaterThan(id1);
  });

  test('createRequest builds valid request', () => {
    const req = createRequest('test/method', { key: 'value' });
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('test/method');
    expect(req.params).toEqual({ key: 'value' });
    expect(typeof req.id).toBe('number');
  });

  test('createRequest works without params', () => {
    const req = createRequest('ping');
    expect(req.params).toBeUndefined();
  });

  test('createNotification builds valid notification', () => {
    const notif = createNotification('notifications/initialized');
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('notifications/initialized');
    expect('id' in notif).toBe(false);
  });

  test('parseMessage parses response', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    expect(isResponse(msg)).toBe(true);
    expect(isNotification(msg)).toBe(false);
    if (isResponse(msg)) {
      expect(msg.result).toEqual({ tools: [] });
    }
  });

  test('parseMessage parses notification', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(isNotification(msg)).toBe(true);
    expect(isResponse(msg)).toBe(false);
  });

  test('parseMessage throws on invalid message', () => {
    expect(() => parseMessage('{"foo":"bar"}')).toThrow('Invalid JSON-RPC message');
  });

  test('parseMessage parses error response', () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}');
    expect(isResponse(msg)).toBe(true);
    if (isResponse(msg)) {
      expect(msg.error?.code).toBe(-32601);
    }
  });
});

// ── Adapter Tests ──

describe('adapter', () => {
  test('mcpToolId generates correct format', () => {
    expect(mcpToolId('my-server', 'search')).toBe('mcp__my-server__search');
    expect(mcpToolId('fs', 'read')).toBe('mcp__fs__read');
  });

  test('adaptMcpTool creates valid ToolDefinition', () => {
    const mcpTool: McpTool = {
      name: 'search',
      description: 'Search for files',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number' },
        },
        required: ['query'],
      },
    };

    const mockClient = {
      callTool: mock(async (_name: string, _args: Record<string, unknown>) => {
        return [
          { type: 'text' as const, text: 'result1' },
          { type: 'text' as const, text: 'result2' },
        ] satisfies McpContent[];
      }),
      getServerName: () => 'test-server',
      getServerConfig: () => ({ name: 'test-server', transport: { type: 'stdio' as const, command: 'test' } }),
    } as unknown as McpClient;

    const adapted = adaptMcpTool(mcpTool, mockClient, 'test-server');

    expect(adapted.name).toBe('mcp__test-server__search');
    expect(adapted.description).toContain('Search for files');
    expect(adapted.category).toBe('mcp');
    expect(adapted.parameters.type).toBe('object');
    expect(adapted.parameters.properties).toEqual({
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number' },
    });
    expect(adapted.timeoutMs).toBe(30_000);
  });

  test('adaptMcpTool execute calls client and returns content', async () => {
    const mcpTool: McpTool = {
      name: 'echo',
      description: 'Echo input',
      inputSchema: { type: 'object', properties: {} },
    };

    const mockClient = {
      callTool: mock(async (_name: string, args: Record<string, unknown>) => {
        return [{ type: 'text' as const, text: `Hello ${args.name}` }] satisfies McpContent[];
      }),
    } as unknown as McpClient;

    const adapted = adaptMcpTool(mcpTool, mockClient, 'test-server');

    const ctx = { agentId: 'agent-1', sessionId: 'session-1', signal: new AbortController().signal };
    const result = await adapted.execute({ name: 'world' }, ctx);

    expect(result.content).toBe('Hello world');
    expect(result.error).toBeUndefined();
    expect(result.metadata?.server).toBe('test-server');
    expect(result.metadata?.mcpTool).toBe('echo');
  });

  test('adaptMcpTool execute handles errors', async () => {
    const mcpTool: McpTool = {
      name: 'failing',
      description: 'Always fails',
      inputSchema: { type: 'object', properties: {} },
    };

    const mockClient = {
      callTool: mock(async () => {
        throw new Error('Server error');
      }),
    } as unknown as McpClient;

    const adapted = adaptMcpTool(mcpTool, mockClient, 'test-server');

    const ctx = { agentId: 'agent-1', sessionId: 'session-1', signal: new AbortController().signal };
    const result = await adapted.execute({}, ctx);

    expect(result.content).toBe('');
    expect(result.error).toContain('MCP tool error');
    expect(result.error).toContain('Server error');
  });

  test('adaptMcpTool uses custom timeout', () => {
    const mcpTool: McpTool = {
      name: 'slow',
      description: 'Slow tool',
      inputSchema: { type: 'object', properties: {} },
    };

    const mockClient = {} as McpClient;
    const adapted = adaptMcpTool(mcpTool, mockClient, 'test-server', 60_000);
    expect(adapted.timeoutMs).toBe(60_000);
  });

  test('adaptMcpTool handles image content', async () => {
    const mcpTool: McpTool = {
      name: 'screenshot',
      description: 'Take screenshot',
      inputSchema: { type: 'object', properties: {} },
    };

    const mockClient = {
      callTool: mock(async () => {
        return [
          { type: 'text' as const, text: 'Screenshot taken:' },
          { type: 'image' as const, data: 'base64data', mimeType: 'image/png' },
        ] satisfies McpContent[];
      }),
    } as unknown as McpClient;

    const adapted = adaptMcpTool(mcpTool, mockClient, 'test-server');
    const ctx = { agentId: 'agent-1', sessionId: 'session-1', signal: new AbortController().signal };
    const result = await adapted.execute({}, ctx);

    expect(result.content).toContain('Screenshot taken:');
    expect(result.content).toContain('[image: image/png]');
  });

  test('adaptMcpTool handles resource content', async () => {
    const mcpTool: McpTool = {
      name: 'read-resource',
      description: 'Read resource',
      inputSchema: { type: 'object', properties: {} },
    };

    const mockClient = {
      callTool: mock(async () => {
        return [
          {
            type: 'resource' as const,
            resource: { uri: 'file:///test.txt', text: 'file content' },
          },
        ] satisfies McpContent[];
      }),
    } as unknown as McpClient;

    const adapted = adaptMcpTool(mcpTool, mockClient, 'test-server');
    const ctx = { agentId: 'agent-1', sessionId: 'session-1', signal: new AbortController().signal };
    const result = await adapted.execute({}, ctx);

    expect(result.content).toBe('file content');
  });
});

// ── Types Tests ──

describe('types', () => {
  test('McpTool inputSchema has correct structure', () => {
    const tool: McpTool = {
      name: 'test',
      description: 'Test tool',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      },
    };

    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['name']);
  });
});
