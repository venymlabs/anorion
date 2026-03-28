import type { AgentConfig, Agent } from '../shared/types';
import type { Db } from '../shared/db';
import type { PreparedStatements } from '../shared/db/prepared';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../shared/logger';

class AgentRegistry {
  private agents = new Map<string, Agent>();
  private db: Db | null = null;
  private prepared: PreparedStatements | null = null;

  setDb(db: Db, prepared: PreparedStatements): void {
    this.db = db;
    this.prepared = prepared;
  }

  async loadFromDirectory(dir: string): Promise<void> {
    const absDir = resolve(process.cwd(), dir);
    if (!existsSync(absDir)) {
      logger.warn({ dir: absDir }, 'Agent directory not found');
      return;
    }

    const files = readdirSync(absDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(absDir, file), 'utf-8');
        const parsed = parseYaml(raw) as Partial<AgentConfig>;
        if (!parsed.name) continue;
        await this.create({
          id: parsed.id || crypto.randomUUID().slice(0, 10),
          name: parsed.name,
          model: parsed.model || 'openai/gpt-4o',
          systemPrompt: parsed.systemPrompt || 'You are a helpful assistant.',
          tools: parsed.tools || [],
          maxIterations: parsed.maxIterations || 10,
          timeoutMs: parsed.timeoutMs || 120000,
          tags: parsed.tags,
          metadata: parsed.metadata,
        });
      } catch (err) {
        logger.error({ file, error: (err as Error).message }, 'Failed to load agent YAML');
      }
    }
  }

  async create(config: AgentConfig): Promise<Agent> {
    const now = new Date().toISOString();
    const agent: Agent = {
      ...config,
      id: config.id || crypto.randomUUID().slice(0, 10),
      state: 'idle',
      createdAt: now,
      updatedAt: now,
    };

    this.agents.set(agent.id, agent);

    if (this.prepared) {
      this.prepared.agentInsert.run({
        $id: agent.id,
        $name: agent.name,
        $model: agent.model,
        $fallbackModel: agent.fallbackModel ?? null,
        $systemPrompt: agent.systemPrompt,
        $tools: JSON.stringify(agent.tools),
        $maxIterations: agent.maxIterations ?? null,
        $timeoutMs: agent.timeoutMs ?? null,
        $state: agent.state,
        $tags: JSON.stringify(agent.tags || []),
        $metadata: JSON.stringify(agent.metadata || {}),
        $createdAt: agent.createdAt,
        $updatedAt: agent.updatedAt,
      });
    }

    logger.info({ agent: agent.name, id: agent.id }, 'Agent created');
    return agent;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getByName(name: string): Agent | undefined {
    return [...this.agents.values()].find((a) => a.name === name);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  async update(id: string, updates: Partial<AgentConfig>): Promise<Agent | undefined> {
    const existing = this.agents.get(id);
    if (!existing) return undefined;

    const updated: Agent = {
      ...existing,
      ...updates,
      id: existing.id, // prevent id change
      state: existing.state,
      updatedAt: new Date().toISOString(),
    };

    this.agents.set(id, updated);

    if (this.prepared) {
      this.prepared.agentUpdate.run({
        $id,
        $name: updated.name,
        $model: updated.model,
        $fallbackModel: updated.fallbackModel ?? null,
        $systemPrompt: updated.systemPrompt,
        $tools: JSON.stringify(updated.tools),
        $maxIterations: updated.maxIterations ?? null,
        $timeoutMs: updated.timeoutMs ?? null,
        $tags: JSON.stringify(updated.tags || []),
        $metadata: JSON.stringify(updated.metadata || {}),
        $updatedAt: updated.updatedAt,
      });
    }

    logger.info({ agent: updated.name, id }, 'Agent updated');
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.agents.get(id);
    if (!existing) return false;

    this.agents.delete(id);

    if (this.prepared) {
      this.prepared.agentDelete.run({ $id: id });
    }

    logger.info({ agent: existing.name, id }, 'Agent deleted');
    return true;
  }

  setState(id: string, state: Agent['state']): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.state = state;
    }
  }
}

export const agentRegistry = new AgentRegistry();
