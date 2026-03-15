import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { logger } from '../shared/logger';

export type MemoryCategory = 'identity' | 'preference' | 'fact' | 'lesson' | 'context';

interface MemoryFileEntry {
  key: string;
  value: unknown;
  category: MemoryCategory;
  createdAt: string;
  updatedAt: string;
}

class MemoryManager {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || resolve(process.cwd(), 'data', 'memory');
    mkdirSync(this.basePath, { recursive: true });
  }

  private agentDir(agentId: string): string {
    return join(this.basePath, agentId);
  }

  private ensureAgentDir(agentId: string): void {
    mkdirSync(this.agentDir(agentId), { recursive: true });
  }

  save(agentId: string, category: MemoryCategory, key: string, value: unknown): MemoryFileEntry {
    this.ensureAgentDir(agentId);
    const now = new Date().toISOString();
    const entry: MemoryFileEntry = {
      key,
      value,
      category,
      createdAt: now,
      updatedAt: now,
    };

    // Check if existing
    const existing = this.getByKey(agentId, key);
    if (existing) {
      entry.createdAt = existing.createdAt;
    }

    const filePath = join(this.agentDir(agentId), `${this.sanitizeKey(key)}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');

    logger.debug({ agentId, category, key }, 'Memory saved');
    return entry;
  }

  load(agentId: string): MemoryFileEntry[] {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return [];

    const entries: MemoryFileEntry[] = [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const entry = JSON.parse(raw) as MemoryFileEntry;
        entries.push(entry);
      } catch {
        // skip corrupt files
      }
    }

    return entries;
  }

  loadByCategory(agentId: string, category: MemoryCategory): MemoryFileEntry[] {
    return this.load(agentId).filter((e) => e.category === category);
  }

  search(agentId: string, query: string): MemoryFileEntry[] {
    const entries = this.load(agentId);
    const terms = query.toLowerCase().split(/\s+/);

    return entries.filter((entry) => {
      const haystack = [
        entry.key,
        typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value),
        entry.category,
      ].join(' ').toLowerCase();

      return terms.every((term) => haystack.includes(term));
    });
  }

  forget(agentId: string, key: string): boolean {
    const filePath = join(this.agentDir(agentId), `${this.sanitizeKey(key)}.json`);
    if (!existsSync(filePath)) return false;
    rmSync(filePath);
    logger.debug({ agentId, key }, 'Memory forgotten');
    return true;
  }

  getByKey(agentId: string, key: string): MemoryFileEntry | null {
    const filePath = join(this.agentDir(agentId), `${this.sanitizeKey(key)}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as MemoryFileEntry;
    } catch {
      return null;
    }
  }

  clear(agentId: string): boolean {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true });
    logger.info({ agentId }, 'All memory cleared');
    return true;
  }

  /** Build a memory context string for injection into system prompts */
  buildContext(agentId: string): string {
    const entries = this.load(agentId);
    if (entries.length === 0) return '';

    const lines: string[] = ['[Agent Memory]'];
    for (const entry of entries) {
      const val = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
      lines.push(`- [${entry.category}] ${entry.key}: ${val}`);
    }
    return lines.join('\n');
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  }
}

export const memoryManager = new MemoryManager();
