// Shared Blackboard for inter-agent communication
// Agents can read/write entries to share state during collaboration

import { nanoid } from 'nanoid';
import type { BlackboardEntry } from './types';

export class Blackboard {
  private entries = new Map<string, BlackboardEntry>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /** Write an entry to the blackboard */
  write(agentId: string, key: string, value: unknown, ttl?: number): BlackboardEntry {
    const entry: BlackboardEntry = {
      id: nanoid(8),
      agentId,
      key,
      value,
      timestamp: Date.now(),
      ttl,
    };
    this.entries.set(`${agentId}:${key}`, entry);
    this.evictIfNeeded();
    return entry;
  }

  /** Read an entry from the blackboard */
  read(key: string, agentId?: string): BlackboardEntry | undefined {
    if (agentId) {
      return this.entries.get(`${agentId}:${key}`);
    }
    // Search across all agents
    for (const [, entry] of this.entries) {
      if (entry.key === key) return entry;
    }
    return undefined;
  }

  /** Read all entries for a key across agents */
  readAll(key: string): BlackboardEntry[] {
    const results: BlackboardEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.key === key) results.push(entry);
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get all entries */
  getAll(): BlackboardEntry[] {
    return [...this.entries.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get entries by agent */
  getByAgent(agentId: string): BlackboardEntry[] {
    const results: BlackboardEntry[] = [];
    for (const [k, entry] of this.entries) {
      if (entry.agentId === agentId) results.push(entry);
    }
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Delete an entry */
  delete(key: string, agentId?: string): boolean {
    if (agentId) {
      return this.entries.delete(`${agentId}:${key}`);
    }
    let deleted = false;
    for (const [k, entry] of this.entries) {
      if (entry.key === key) {
        this.entries.delete(k);
        deleted = true;
      }
    }
    return deleted;
  }

  /** Purge expired entries */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [k, entry] of this.entries) {
      if (entry.ttl && now - entry.timestamp > entry.ttl) {
        this.entries.delete(k);
        purged++;
      }
    }
    return purged;
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
  }

  /** Number of entries */
  get size(): number {
    return this.entries.size;
  }

  /** Build a summary string for agents to read */
  buildSummary(keys?: string[]): string {
    const entries = keys
      ? keys.flatMap((k) => this.readAll(k))
      : this.getAll();

    if (entries.length === 0) return '[No shared context]';

    return entries
      .map((e) => `[${e.agentId}] ${e.key}: ${JSON.stringify(e.value)}`)
      .join('\n');
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxSize) return;
    const sorted = [...this.entries.entries()]
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);
    const toRemove = this.entries.size - this.maxSize;
    for (let i = 0; i < toRemove; i++) {
      if (sorted[i]) this.entries.delete(sorted[i]![0]);
    }
  }
}
