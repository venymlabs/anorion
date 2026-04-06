// MCP Tool Adapter — wraps MCP tools as Anorion native ToolDefinitions
import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import type { McpTool, McpContent } from './types';
import type { McpClient } from './client';
import { logger } from '../../shared/logger';

/**
 * Prefix for all MCP-sourced tools to avoid name collisions with builtin tools.
 * Format: `mcp__{serverName}__{toolName}`
 */
export function mcpToolId(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Convert MCP content blocks to a flat string */
function contentToString(content: McpContent[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'image':
          return `[image: ${block.mimeType}]`;
        case 'resource':
          return block.resource.text ?? `[resource: ${block.resource.uri}]`;
        default:
          return '';
      }
    })
    .join('\n');
}

/**
 * Adapt a single MCP tool into an Anorion ToolDefinition.
 * The execute function calls the MCP client to invoke the remote tool.
 */
export function adaptMcpTool(
  tool: McpTool,
  client: McpClient,
  serverName: string,
  toolTimeoutMs?: number,
): ToolDefinition {
  const id = mcpToolId(serverName, tool.name);

  return {
    name: id,
    description: tool.description ?? `MCP tool: ${tool.name} (from ${serverName})`,
    parameters: {
      type: 'object',
      properties: tool.inputSchema.properties ?? {},
      required: tool.inputSchema.required ?? [],
    },
    category: 'mcp',
    timeoutMs: toolTimeoutMs ?? 30_000,
    execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const content = await client.callTool(tool.name, params);

        return {
          content: contentToString(content),
          metadata: {
            server: serverName,
            mcpTool: tool.name,
            agentId: ctx.agentId,
          },
        };
      } catch (err) {
        const error = err as Error;
        logger.error({ server: serverName, tool: tool.name, error: error.message }, 'MCP tool call failed');
        return {
          content: '',
          error: `MCP tool error (${serverName}/${tool.name}): ${error.message}`,
          metadata: {
            server: serverName,
            mcpTool: tool.name,
          },
        };
      }
    },
  };
}

/**
 * Adapt all tools from an MCP client into Anorion ToolDefinitions.
 */
export function adaptAllMcpTools(client: McpClient, toolTimeoutMs?: number): ToolDefinition[] {
  const serverName = client.getServerName();
  const mcpTools = client.getTools();

  return mcpTools.map((tool) => adaptMcpTool(tool, client, serverName, toolTimeoutMs));
}
