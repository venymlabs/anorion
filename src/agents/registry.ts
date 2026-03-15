import type { AgentConfig, Agent } from '../shared/types';
import type { Db } from '../shared/db';
import { agents } from '../shared/db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../shared/logger';

class AgentRegistry {
  private agents = new Map<string, Agent>();
  private db: Db | null = null;

  setDb(db: Db): void {
    this.db = db;
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
          id: parsed.id || nanoid(10),
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
      id: config.id || nanoid(10),
      state: 'idle',
      createdAt: now,
      updatedAt: now,
    };

    this.agents.set(agent.id, agent);

    if (this.db) {
      await this.db.insert(agents).values({
        id: agent.id,
        name: agent.name,
        model: agent.model,
        fallbackModel: agent.fallbackModel,
        systemPrompt: agent.systemPrompt,
        tools: JSON.stringify(agent.tools),
        maxIterations: agent.maxIterations,
        timeoutMs: agent.timeoutMs,
        state: agent.state,
        tags: JSON.stringify(agent.tags || []),
        metadata: JSON.stringify(agent.metadata || {}),
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      }).onConflictDoUpdate({
        target: agents.id,
        set: { updatedAt: now },
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

    if (this.db) {
      await this.db.update(agents).set({
        name: updated.name,
        model: updated.model,
        fallbackModel: updated.fallbackModel,
        systemPrompt: updated.systemPrompt,
        tools: JSON.stringify(updated.tools),
        maxIterations: updated.maxIterations,
        timeoutMs: updated.timeoutMs,
        tags: JSON.stringify(updated.tags || []),
        metadata: JSON.stringify(updated.metadata || {}),
        updatedAt: updated.updatedAt,
      }).where(eq(agents.id, id));
    }

    logger.info({ agent: updated.name, id }, 'Agent updated');
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.agents.get(id);
    if (!existing) return false;

    this.agents.delete(id);

    if (this.db) {
      await this.db.delete(agents).where(eq(agents.id, id));
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
