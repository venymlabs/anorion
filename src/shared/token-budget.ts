// Token Budget System — per-agent and global token usage tracking with caps

import { eventBus } from '../shared/events';
import { logger } from '../shared/logger';

export interface TokenBudgetConfig {
  /** Max tokens per session (default: 500000) */
  sessionLimit: number;
  /** Max tokens per day per agent (default: 2000000) */
  dailyLimit: number;
  /** Global daily limit across all agents (default: 10000000) */
  globalDailyLimit: number;
  /** Graceful message when budget exhausted */
  exhaustedMessage: string;
  /** Whether to track or enforce (default: enforce) */
  mode: 'track' | 'enforce';
}

interface AgentUsage {
  agentId: string;
  dailyUsed: number;
  sessionUsage: Map<string, number>;
  lastReset: number; // timestamp
}

const DEFAULT_CONFIG: TokenBudgetConfig = {
  sessionLimit: 500_000,
  dailyLimit: 2_000_000,
  globalDailyLimit: 10_000_000,
  exhaustedMessage: 'Token budget exhausted. Please try again later or start a new session.',
  mode: 'enforce',
};

class TokenBudgetManager {
  private config: TokenBudgetConfig;
  private agentUsage = new Map<string, AgentUsage>();
  private globalDailyUsed = 0;
  private lastGlobalReset: number;

  constructor(config?: Partial<TokenBudgetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastGlobalReset = this.startOfDay();

    // Listen to token usage events
    eventBus.on('token:usage', (data) => {
      this.recordUsage(data.agentId, data.sessionId, data.promptTokens + data.completionTokens);
    });
  }

  /** Check if an agent+session can spend tokens. Returns true if allowed. */
  canSpend(agentId: string, sessionId: string, estimatedTokens: number): { allowed: boolean; reason?: string } {
    if (this.config.mode === 'track') return { allowed: true };

    this.maybeReset();

    // Check global
    if (this.globalDailyUsed + estimatedTokens > this.config.globalDailyLimit) {
      logger.warn({ globalUsed: this.globalDailyUsed, limit: this.config.globalDailyLimit }, 'Global daily token budget exceeded');
      return { allowed: false, reason: 'Global daily token budget exceeded' };
    }

    // Check agent daily
    const usage = this.getOrCreateUsage(agentId);
    if (usage.dailyUsed + estimatedTokens > this.config.dailyLimit) {
      logger.warn({ agentId, dailyUsed: usage.dailyUsed, limit: this.config.dailyLimit }, 'Agent daily token budget exceeded');
      return { allowed: false, reason: `Agent daily budget exceeded (${usage.dailyUsed}/${this.config.dailyLimit})` };
    }

    // Check session
    const sessionUsed = usage.sessionUsage.get(sessionId) || 0;
    if (sessionUsed + estimatedTokens > this.config.sessionLimit) {
      logger.warn({ agentId, sessionId, sessionUsed, limit: this.config.sessionLimit }, 'Session token budget exceeded');
      return { allowed: false, reason: `Session budget exceeded (${sessionUsed}/${this.config.sessionLimit})` };
    }

    return { allowed: true };
  }

  /** Record actual token usage */
  recordUsage(agentId: string, sessionId: string, tokens: number): void {
    this.maybeReset();
    const usage = this.getOrCreateUsage(agentId);
    usage.dailyUsed += tokens;
    usage.sessionUsage.set(sessionId, (usage.sessionUsage.get(sessionId) || 0) + tokens);
    this.globalDailyUsed += tokens;
  }

  /** Get usage stats for an agent */
  getUsage(agentId: string): { dailyUsed: number; dailyLimit: number; sessionCount: number } {
    const usage = this.agentUsage.get(agentId);
    return {
      dailyUsed: usage?.dailyUsed || 0,
      dailyLimit: this.config.dailyLimit,
      sessionCount: usage?.sessionUsage.size || 0,
    };
  }

  /** Get global usage */
  getGlobalUsage(): { dailyUsed: number; dailyLimit: number; agentCount: number } {
    return {
      dailyUsed: this.globalDailyUsed,
      dailyLimit: this.config.globalDailyLimit,
      agentCount: this.agentUsage.size,
    };
  }

  /** Reset a specific agent's daily budget */
  resetAgent(agentId: string): void {
    this.agentUsage.delete(agentId);
  }

  /** Reset a specific session's budget */
  resetSession(agentId: string, sessionId: string): void {
    const usage = this.agentUsage.get(agentId);
    if (usage) usage.sessionUsage.delete(sessionId);
  }

  /** Update config at runtime */
  updateConfig(updates: Partial<TokenBudgetConfig>): void {
    Object.assign(this.config, updates);
    logger.info({ config: this.config }, 'Token budget config updated');
  }

  getConfig(): TokenBudgetConfig {
    return { ...this.config };
  }

  private getOrCreateUsage(agentId: string): AgentUsage {
    if (!this.agentUsage.has(agentId)) {
      this.agentUsage.set(agentId, {
        agentId,
        dailyUsed: 0,
        sessionUsage: new Map(),
        lastReset: this.startOfDay(),
      });
    }
    return this.agentUsage.get(agentId)!;
  }

  private maybeReset(): void {
    const today = this.startOfDay();
    if (today > this.lastGlobalReset) {
      this.globalDailyUsed = 0;
      this.lastGlobalReset = today;
      this.agentUsage.clear();
      logger.info('Daily token budgets reset');
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

export const tokenBudget = new TokenBudgetManager();
