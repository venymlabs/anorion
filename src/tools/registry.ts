import type { ToolDefinition, ToolContext, ToolResult } from '../shared/types';
import { logger } from '../shared/logger';

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private perAgent = new Map<string, Set<string>>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
    logger.debug({ tool: def.name }, 'Tool registered');
  }

  unregister(name: string): boolean {
    // Remove from all agent bindings
    for (const [, bound] of this.perAgent) {
      bound.delete(name);
    }
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  listForAgent(agentId: string): ToolDefinition[] {
    const allowed = this.perAgent.get(agentId);
    if (!allowed) return [];
    return [...allowed].map((name) => this.tools.get(name)!).filter(Boolean);
  }

  getToolNamesForAgent(agentId: string): string[] {
    return [...(this.perAgent.get(agentId) || [])];
  }

  bindTools(agentId: string, toolNames: string[]): void {
    const bound = new Set<string>();
    for (const name of toolNames) {
      if (!this.tools.has(name)) {
        logger.warn({ tool: name }, 'Tool not found, skipping');
        continue;
      }
      bound.add(name);
    }
    this.perAgent.set(agentId, bound);
    logger.debug({ agentId, tools: [...bound] }, 'Tools bound to agent');
  }

  getSchemasForAgent(agentId: string) {
    return this.listForAgent(agentId).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

export const toolRegistry = new ToolRegistry();
