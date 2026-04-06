// Collaboration Metrics Tracking

import type { CollaborationMetrics, AgentCost, CostSummary, CollaborationSession } from './types';

export class MetricsTracker {
  private costs = new Map<string, AgentCost>();
  private utilization = new Map<string, number>();
  private startTime = Date.now();

  /** Record token usage for an agent */
  recordTokens(agentId: string, promptTokens: number, completionTokens: number): void {
    const existing = this.costs.get(agentId) || {
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      calls: 0,
    };
    existing.tokens += promptTokens + completionTokens;
    existing.promptTokens += promptTokens;
    existing.completionTokens += completionTokens;
    existing.calls += 1;
    this.costs.set(agentId, existing);
  }

  /** Record agent utilization (active time in ms) */
  recordUtilization(agentId: string, durationMs: number): void {
    const existing = this.utilization.get(agentId) || 0;
    this.utilization.set(agentId, existing + durationMs);
  }

  /** Get cost summary */
  getCostSummary(): CostSummary {
    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCalls = 0;

    for (const cost of this.costs.values()) {
      totalTokens += cost.tokens;
      totalPromptTokens += cost.promptTokens;
      totalCompletionTokens += cost.completionTokens;
      totalCalls += cost.calls;
    }

    return {
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalCalls,
      perAgent: new Map(this.costs),
    };
  }

  /** Build final metrics from session */
  buildMetrics(session: CollaborationSession): CollaborationMetrics {
    const costSummary = this.getCostSummary();
    return {
      sessionId: session.id,
      pattern: session.pattern,
      totalDurationMs: Date.now() - this.startTime,
      totalTokens: costSummary.totalTokens,
      agentCount: new Set(session.tasks.map((t) => t.agentId)).size,
      taskCount: session.tasks.length,
      completedTasks: session.tasks.filter((t) => t.status === 'completed').length,
      failedTasks: session.tasks.filter((t) => t.status === 'failed').length,
      agreementScore: session.result?.agreement,
      agentUtilization: new Map(this.utilization),
      costPerAgent: new Map(this.costs),
    };
  }

  /** Get utilization percentages */
  getUtilizationPercentages(): Map<string, number> {
    const totalMs = Date.now() - this.startTime;
    const percentages = new Map<string, number>();
    for (const [agentId, durationMs] of this.utilization) {
      percentages.set(agentId, totalMs > 0 ? (durationMs / totalMs) * 100 : 0);
    }
    return percentages;
  }

  /** Format metrics as a readable summary */
  formatSummary(): string {
    const cost = this.getCostSummary();
    const util = this.getUtilizationPercentages();
    const lines: string[] = [
      `Total tokens: ${cost.totalTokens}`,
      `Total calls: ${cost.totalCalls}`,
      `Duration: ${Date.now() - this.startTime}ms`,
      '',
      'Per-agent costs:',
    ];
    for (const [agentId, ac] of cost.perAgent) {
      const pct = util.get(agentId)?.toFixed(1) ?? '0.0';
      lines.push(`  ${agentId}: ${ac.tokens} tokens, ${ac.calls} calls, ${pct}% utilization`);
    }
    return lines.join('\n');
  }
}
