import type { Db } from '../shared/db';
import { schedules } from '../shared/db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { sendMessage } from '../agents/runtime';
import { agentRegistry } from '../agents/registry';
import { logger } from '../shared/logger';
import cron from 'node-cron';

export interface ScheduleJob {
  id: string;
  name: string;
  agentId: string;
  cronExpr: string;
  payload: string;
  enabled: boolean;
  mode?: 'systemEvent' | 'agentTurn';
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

type CronTask = { stop: () => void; task: cron.ScheduledTask };

class ScheduleManager {
  private db: Db | null = null;
  private jobs = new Map<string, ScheduleJob>();
  private tasks = new Map<string, CronTask>();

  setDb(db: Db): void {
    this.db = db;
  }

  async loadAll(): Promise<void> {
    if (!this.db) return;
    const rows = await this.db.select().from(schedules);
    for (const row of rows) {
      const job: ScheduleJob = {
        id: row.id,
        name: row.name,
        agentId: row.agentId,
        cronExpr: row.cronExpr,
        payload: row.task,
        enabled: row.enabled,
        lastRunAt: row.lastRun ?? undefined,
        nextRunAt: row.nextRun ?? undefined,
        createdAt: row.createdAt,
      };
      this.jobs.set(job.id, job);
      if (job.enabled) {
        this.startCron(job);
      }
    }
    logger.info({ count: rows.length }, 'Schedules loaded');
  }

  async create(input: { name: string; agentId: string; schedule: string; payload: string; mode?: 'systemEvent' | 'agentTurn' }): Promise<ScheduleJob> {
    const id = nanoid(10);
    const now = new Date().toISOString();

    // Validate cron expression
    if (!cron.validate(input.schedule)) {
      throw new Error(`Invalid cron expression: ${input.schedule}`);
    }

    const agent = agentRegistry.get(input.agentId) || agentRegistry.getByName(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);

    const job: ScheduleJob = {
      id,
      name: input.name,
      agentId: agent.id,
      cronExpr: input.schedule,
      payload: input.payload,
      enabled: true,
      mode: input.mode || 'agentTurn',
      createdAt: now,
    };

    this.jobs.set(id, job);

    if (this.db) {
      await this.db.insert(schedules).values({
        id: job.id,
        agentId: job.agentId,
        name: job.name,
        cronExpr: job.cronExpr,
        task: job.payload,
        enabled: true,
        createdAt: now,
      });
    }

    this.startCron(job);
    logger.info({ id, name: job.name, agentId: job.agentId, cron: job.cronExpr }, 'Schedule created');
    return job;
  }

  list(): ScheduleJob[] {
    return [...this.jobs.values()];
  }

  get(id: string): ScheduleJob | undefined {
    return this.jobs.get(id);
  }

  async update(id: string, updates: Partial<{ name: string; schedule: string; payload: string; enabled: boolean; mode: string }>): Promise<ScheduleJob | undefined> {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;

    if (updates.schedule) {
      if (!cron.validate(updates.schedule)) {
        throw new Error(`Invalid cron expression: ${updates.schedule}`);
      }
    }

    // Stop existing cron
    this.stopCron(id);

    const updated: ScheduleJob = {
      ...existing,
      ...(updates.name && { name: updates.name }),
      ...(updates.schedule && { cronExpr: updates.schedule }),
      ...(updates.payload && { payload: updates.payload }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
      ...(updates.mode && { mode: updates.mode as ScheduleJob['mode'] }),
    };

    this.jobs.set(id, updated);

    if (this.db) {
      await this.db.update(schedules).set({
        name: updated.name,
        cronExpr: updated.cronExpr,
        task: updated.payload,
        enabled: updated.enabled,
      }).where(eq(schedules.id, id));
    }

    if (updated.enabled) {
      this.startCron(updated);
    }

    logger.info({ id, name: updated.name }, 'Schedule updated');
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.jobs.get(id);
    if (!existing) return false;

    this.stopCron(id);
    this.jobs.delete(id);

    if (this.db) {
      await this.db.delete(schedules).where(eq(schedules.id, id));
    }

    logger.info({ id }, 'Schedule removed');
    return true;
  }

  async trigger(id: string): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job) return { success: false, error: 'Schedule not found' };

    try {
      await this.executeJob(job);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async pause(id: string): Promise<boolean> {
    return !!(await this.update(id, { enabled: false }));
  }

  async resume(id: string): Promise<boolean> {
    return !!(await this.update(id, { enabled: true }));
  }

  private startCron(job: ScheduleJob): void {
    this.stopCron(job.id);
    try {
      const task = cron.schedule(job.cronExpr, () => {
        this.executeJob(job).catch((err) => {
          logger.error({ jobId: job.id, error: (err as Error).message }, 'Scheduled job execution failed');
        });
      });
      this.tasks.set(job.id, { stop: () => task.stop(), task });
    } catch (err) {
      logger.error({ jobId: job.id, error: (err as Error).message }, 'Failed to start cron');
    }
  }

  private stopCron(id: string): void {
    const t = this.tasks.get(id);
    if (t) {
      t.stop();
      this.tasks.delete(id);
    }
  }

  private async executeJob(job: ScheduleJob): Promise<void> {
    logger.info({ jobId: job.id, name: job.name }, 'Executing scheduled job');
    const now = new Date().toISOString();
    job.lastRunAt = now;

    if (job.mode === 'systemEvent') {
      // Inject as system event into agent session
      await sendMessage({
        agentId: job.agentId,
        text: `[Scheduled Event: ${job.name}]\n${job.payload}`,
      });
    } else {
      // Isolated agent turn
      await sendMessage({
        agentId: job.agentId,
        text: job.payload,
      });
    }

    if (this.db) {
      await this.db.update(schedules).set({
        lastRun: now,
      }).where(eq(schedules.id, job.id));
    }
  }

  shutdown(): void {
    for (const [, t] of this.tasks) {
      t.stop();
    }
    this.tasks.clear();
    logger.info('Scheduler shut down');
  }
}

export const scheduleManager = new ScheduleManager();
