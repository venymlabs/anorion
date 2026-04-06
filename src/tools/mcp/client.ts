// MCP Client — connects to a single MCP server, discovers tools/resources/prompts
import type {
  McpServerConfig,
  McpConnectionState,
  InitializeResult,
  McpTool,
  McpResource,
  McpResourceTemplate,
  McpPrompt,
  McpContent,
  JsonRpcResponse,
  ClientCapabilities,
  Implementation,
} from './types';
import { createRequest, createNotification } from './json-rpc';
import type { Transport } from './transport';
import { StdioTransport, SseTransport } from './transport';
import { logger } from '../../shared/logger';

const CLIENT_INFO: Implementation = { name: 'anorion-mcp-client', version: '0.1.0' };
const CLIENT_CAPABILITIES: ClientCapabilities = {};
const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  state: McpConnectionState = 'disconnected';
  serverInfo: Implementation | null = null;
  serverCapabilities: InitializeResult['capabilities'] | null = null;

  private transport: Transport;
  private tools: McpTool[] = [];
  private resources: McpResource[] = [];
  private resourceTemplates: McpResourceTemplate[] = [];
  private prompts: McpPrompt[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: McpServerConfig) {
    this.transport = this.createTransport(config);
  }

  private createTransport(config: McpServerConfig): Transport {
    switch (config.transport.type) {
      case 'stdio':
        return new StdioTransport(
          config.transport.command,
          config.transport.args,
          config.transport.env,
        );
      case 'sse':
        return new SseTransport(config.transport.url, config.transport.headers);
      default:
        throw new Error(`Unknown transport type: ${(config.transport as any).type}`);
    }
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    if (this.state === 'connected') return;

    this.state = 'connecting';
    logger.info({ server: this.config.name }, 'MCP connecting...');

    try {
      // Connect transport
      await this.transport.start();

      // Initialize handshake
      const initResult = await this.sendRequest<InitializeResult>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      });

      this.serverInfo = initResult.serverInfo;
      this.serverCapabilities = initResult.capabilities;

      // Send initialized notification
      this.transport.notify(createNotification('notifications/initialized'));

      this.state = 'connected';
      this.reconnectAttempts = 0;

      // Discover capabilities
      await this.discover();

      logger.info(
        { server: this.config.name, serverInfo: this.serverInfo, tools: this.tools.length, resources: this.resources.length },
        'MCP connected',
      );
    } catch (err) {
      this.state = 'error';
      logger.error({ server: this.config.name, error: (err as Error).message }, 'MCP connection failed');

      if (this.shouldReconnect()) {
        this.scheduleReconnect();
      }

      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.cancelReconnect();
    this.transport.close();
    this.state = 'disconnected';
    this.tools = [];
    this.resources = [];
    this.resourceTemplates = [];
    this.prompts = [];
    logger.info({ server: this.config.name }, 'MCP disconnected');
  }

  // ── Discovery ──

  async discover(): Promise<void> {
    await Promise.allSettled([
      this.discoverTools(),
      this.discoverResources(),
      this.discoverPrompts(),
    ]);
  }

  async discoverTools(): Promise<McpTool[]> {
    if (!this.serverCapabilities?.tools) {
      this.tools = [];
      return this.tools;
    }

    try {
      const result = await this.sendRequest<{ tools: McpTool[] }>('tools/list');
      this.tools = result.tools ?? [];
      logger.debug({ server: this.config.name, count: this.tools.length }, 'MCP tools discovered');
    } catch (err) {
      logger.warn({ server: this.config.name, error: (err as Error).message }, 'MCP tool discovery failed');
      this.tools = [];
    }
    return this.tools;
  }

  async discoverResources(): Promise<McpResource[]> {
    if (!this.serverCapabilities?.resources) {
      this.resources = [];
      return this.resources;
    }

    try {
      const [listResult, templateResult] = await Promise.allSettled([
        this.sendRequest<{ resources: McpResource[] }>('resources/list'),
        this.sendRequest<{ resourceTemplates: McpResourceTemplate[] }>('resources/templates/list'),
      ]);

      this.resources = listResult.status === 'fulfilled' ? (listResult.value.resources ?? []) : [];
      this.resourceTemplates = templateResult.status === 'fulfilled' ? (templateResult.value.resourceTemplates ?? []) : [];

      logger.debug({ server: this.config.name, resources: this.resources.length, templates: this.resourceTemplates.length }, 'MCP resources discovered');
    } catch (err) {
      logger.warn({ server: this.config.name, error: (err as Error).message }, 'MCP resource discovery failed');
      this.resources = [];
    }
    return this.resources;
  }

  async discoverPrompts(): Promise<McpPrompt[]> {
    if (!this.serverCapabilities?.prompts) {
      this.prompts = [];
      return this.prompts;
    }

    try {
      const result = await this.sendRequest<{ prompts: McpPrompt[] }>('prompts/list');
      this.prompts = result.prompts ?? [];
      logger.debug({ server: this.config.name, count: this.prompts.length }, 'MCP prompts discovered');
    } catch (err) {
      logger.warn({ server: this.config.name, error: (err as Error).message }, 'MCP prompt discovery failed');
      this.prompts = [];
    }
    return this.prompts;
  }

  // ── Tool Invocation ──

  async callTool(name: string, args: Record<string, unknown>): Promise<McpContent[]> {
    const timeout = this.config.toolTimeoutMs ?? 30_000;

    const result = await this.sendRequest<{ content: McpContent[]; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
      timeout,
    );

    return result.content ?? [];
  }

  // ── Resources ──

  async readResource(uri: string): Promise<McpContent[]> {
    const result = await this.sendRequest<{ contents: McpContent[] }>('resources/read', { uri });
    return result.contents ?? [];
  }

  // ── Prompts ──

  async getPrompt(name: string, args?: Record<string, string>) {
    return this.sendRequest<{
      description?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: McpContent }>;
    }>('prompts/get', { name, arguments: args });
  }

  // ── Health Check ──

  async healthCheck(): Promise<boolean> {
    if (this.state !== 'connected' || !this.transport.connected) {
      return false;
    }

    try {
      // Ping is a standard MCP method for health checks
      await this.sendRequest('ping', {}, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  // ── Getters ──

  getTools(): McpTool[] {
    return this.tools;
  }

  getResources(): McpResource[] {
    return this.resources;
  }

  getPrompts(): McpPrompt[] {
    return this.prompts;
  }

  getServerName(): string {
    return this.config.name;
  }

  getServerConfig(): McpServerConfig {
    return this.config;
  }

  // ── Internal ──

  private async sendRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const request = createRequest(method, params);

    // Wrap with timeout if specified
    let response: JsonRpcResponse;
    if (timeoutMs) {
      response = await Promise.race([
        this.transport.send(request),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Request timeout: ${method}`)), timeoutMs),
        ),
      ]);
    } else {
      response = await this.transport.send(request);
    }

    if (response.error) {
      throw new Error(`MCP error [${response.error.code}]: ${response.error.message}`);
    }

    return response.result as T;
  }

  private shouldReconnect(): boolean {
    if (this.config.autoReconnect === false) return false;
    const max = this.config.maxReconnectAttempts ?? 5;
    return this.reconnectAttempts < max;
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);

    logger.info({ server: this.config.name, attempt: this.reconnectAttempts, delayMs: delay }, 'MCP reconnecting...');

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        logger.error({ server: this.config.name, error: (err as Error).message }, 'MCP reconnect failed');
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
