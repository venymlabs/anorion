import type { Database } from 'bun:sqlite';
import type { PreparedStatements } from '../shared/db/prepared';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../shared/logger';
import type { AnorionConfig } from '../shared/config';

export interface ConfigSnapshot {
  id: string;
  config: string;
  reason: string | null;
  createdAt: string;
}

class ConfigVersioning {
  private prepared: PreparedStatements | null = null;
  private configPath: string = '';

  init(prepared: PreparedStatements, configPath: string): void {
    this.prepared = prepared;
    this.configPath = configPath || resolve(process.cwd(), 'anorion.yaml');
  }

  /** Save a snapshot of the current config. Returns the snapshot ID. */
  save(reason?: string): string {
    if (!this.prepared) throw new Error('Config versioning not initialized');

    const id = crypto.randomUUID().slice(0, 12);
    const configContent = this.readCurrentConfig();

    this.prepared.configSnapshotInsert.run({
      $id: id,
      $config: configContent,
      $reason: reason || null,
      $createdAt: new Date().toISOString(),
    });

    logger.info({ snapshotId: id, reason }, 'Config snapshot saved');
    return id;
  }

  /** List config snapshots, most recent first. */
  list(limit = 50): ConfigSnapshot[] {
    if (!this.prepared) return [];

    const rows = this.prepared.configSnapshotList.all({ $limit: limit }) as any[];
    return rows.map((r) => ({
      id: r.id,
      config: r.config,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  /** Get a specific snapshot by ID. */
  get(id: string): ConfigSnapshot | null {
    if (!this.prepared) return null;

    const row = this.prepared.configSnapshotGet.get({ $id: id }) as any;
    if (!row) return null;
    return {
      id: row.id,
      config: row.config,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  /** Rollback to a specific snapshot — writes the config file and returns it. */
  rollback(snapshotId: string): ConfigSnapshot | null {
    const snapshot = this.get(snapshotId);
    if (!snapshot) return null;

    // Save current config before overwriting
    this.save(`Pre-rollback snapshot (rolling back to ${snapshotId})`);

    // Write the snapshot config to the config file
    writeFileSync(this.configPath, snapshot.config, 'utf-8');
    logger.info({ snapshotId }, 'Config rolled back');

    return snapshot;
  }

  private readCurrentConfig(): string {
    if (existsSync(this.configPath)) {
      return readFileSync(this.configPath, 'utf-8');
    }
    return '{}';
  }
}

export const configVersioning = new ConfigVersioning();
