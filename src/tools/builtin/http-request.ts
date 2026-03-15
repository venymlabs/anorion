import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';

const httpRequestTool: ToolDefinition = {
  name: 'http-request',
  description: 'Make an HTTP request. Returns status code, headers, and body.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to request' },
      method: { type: 'string', description: 'HTTP method (default GET)' },
      headers: { type: 'object', description: 'Request headers' },
      body: { type: 'string', description: 'Request body (for POST/PUT)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 15000)' },
    },
    required: ['url'],
  },
  category: 'system',
  timeoutMs: 30000,
  maxOutputBytes: 500_000,
  execute: async (params, ctx): Promise<ToolResult> => {
    const url = String(params.url);
    const method = String(params.method || 'GET').toUpperCase();
    const headers = (params.headers as Record<string, string>) || {};
    const body = params.body ? String(params.body) : undefined;
    const timeout = Number(params.timeout) || 15000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = ctx.signal || controller.signal;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      const responseText = await response.text();

      return {
        content: JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseText.slice(0, 100_000),
        }, null, 2),
      };
    } catch (err: unknown) {
      const e = err as Error;
      return { content: '', error: e.name === 'AbortError' ? `Request timed out after ${timeout}ms` : e.message };
    } finally {
      clearTimeout(timer);
    }
  },
};

export default httpRequestTool;
