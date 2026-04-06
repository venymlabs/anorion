// MCP Manager — coordinates multiple MCP server connections and registers tools
import type { McpServerConfig } from './types';
import { McpClient } from './client';
import { adaptAllMcpTools, mcpToolId } from './adapter';
import { toolRegistry } from '../registry';
import { logger } from '../../shared/logger';

export class McpManager {
  private clients = new Map<string, McpClient>();
  private configs = new Map<string, McpServerConfig>();
  private registeredToolNames = new Map<string, string[]>(); // serverName → tool names

  /**
   * Add an MCP server configuration. Does not connect yet.
   */
  addServer(config: McpServerConfig): void {
    if (this.configs.has(config.name)) {
      logger.warn({ server: config.name }, 'MCP server already configured, replacing');
      this.removeServer(config.name);
    }

    this.configs.set(config.name, config);
  }

  /**
   * Remove an MCP server and unregister its tools.
   */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      // Unregister tools
      const toolNames = this.registeredToolNames.get(name) ?? [];
      for (const toolName of toolNames) {
        toolRegistry.unregister(toolName);
      }
      this.registeredToolNames.delete(name);

      await client.disconnect();
      this.clients.delete(name);
    }
    this.configs.delete(name);
  }

  /**
   * Connect to all configured MCP servers and register their tools.
   * Returns the number of servers successfully connected.
   */
  async connectAll(): Promise<{ connected: number; failed: number; tools: number }> {
    let connected = 0;
    let failed = 0;
    let totalTools = 0;

    for (const [name, config] of this.configs) {
      if (config.enabled === false) {
        logger.debug({ server: name }, 'MCP server disabled, skipping');
        continue;
      }

      try {
        await this.connectServer(name);
        connected++;
        const client = this.clients.get(name)!;
        totalTools += client.getTools().length;
      } catch (err) {
        failed++;
        logger.error({ server: name, error: (err as Error).message }, 'MCP server connection failed');
      }
    }

    return { connected, failed, tools: totalTools };
  }

  /**
   * Connect to a single MCP server and register its tools.
   */
  async connectServer(name: string): Promise<McpClient> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`MCP server not configured: ${name}`);

    const client = new McpClient(config);
    await client.connect();

    this.clients.set(name, client);

    // Adapt and register tools
    this.registerServerTools(name, client);

    return client;
  }

  /**
   * Register all tools from a connected client into the tool registry.
   */
  private registerServerTools(name: string, client: McpClient): void {
    // Unregister previous tools for this server
    const prevTools = this.registeredToolNames.get(name) ?? [];
    for (const toolName of prevTools) {
      toolRegistry.unregister(toolName);
    }

    const adapted = adaptAllMcpTools(client, client.getServerConfig?.().toolTimeoutMs);
    const registeredNames: string[] = [];

    for (const tool of adapted) {
      try {
        toolRegistry.register(tool);
        registeredNames.push(tool.name);
      } catch {
        logger.warn({ tool: tool.name }, 'MCP tool already registered, skipping');
      }
    }

    this.registeredToolNames.set(name, registeredNames);
    logger.info({ server: name, tools: registeredNames.length }, 'MCP tools registered');
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.allSettled(names.map((name) => this.removeServer(name)));
    logger.info('All MCP servers disconnected');
  }

  /**
   * Refresh tools from all connected servers.
   */
  async refreshAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.discover();
        this.registerServerTools(name, client);
      } catch (err) {
        logger.error({ server: name, error: (err as Error).message }, 'MCP refresh failed');
      }
    }
  }

  /**
   * Run a health check on all servers.
   */
  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, client] of this.clients) {
      results[name] = await client.healthCheck();
    }
    return results;
  }

  /**
   * Get status info for all servers.
   */
  getStatus(): Array<{
    name: string;
    state: string;
    tools: number;
    resources: number;
    serverInfo?: string;
  }> {
    return [...this.configs.values()].map((config) => {
      const client = this.clients.get(config.name);
      return {
        name: config.name,
        state: client?.state ?? 'disconnected',
        tools: client?.getTools().length ?? 0,
        resources: client?.getResources().length ?? 0,
        serverInfo: client?.serverInfo ? `${client.serverInfo.name}@${client.serverInfo.version}` : undefined,
      };
    });
  }

  /**
   * Get a specific client by server name.
   */
  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }
}

/** Global MCP manager instance */
export const mcpManager = new McpManager();
