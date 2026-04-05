// Metrics — token tracking, latency histograms, error rates

export interface MetricPoint {
  timestamp: number;
  value: number;
  labels: Record<string, string>;
}

export interface LatencyHistogram {
  p50: number;
  p95: number;
  p99: number;
  count: number;
  avg: number;
  min: number;
  max: number;
}

export interface ErrorRate {
  total: number;
  errors: number;
  rate: number; // 0-1
}

class MetricsCollector {
  private latencies: Array<{ ts: number; ms: number; agentId?: string; path: string }> = [];
  private tokenUsage: Array<{ ts: number; agentId: string; model: string; prompt: number; completion: number; total: number }> = [];
  private errors: Array<{ ts: number; path: string; statusCode: number; error?: string }> = [];
  private readonly MAX_ENTRIES = 50_000;

  recordLatency(ms: number, path: string, agentId?: string): void {
    this.latencies.push({ ts: Date.now(), ms, path, agentId });
    if (this.latencies.length > this.MAX_ENTRIES) {
      this.latencies.splice(0, this.latencies.length - this.MAX_ENTRIES);
    }
  }

  recordTokens(agentId: string, model: string, prompt: number, completion: number): void {
    this.tokenUsage.push({
      ts: Date.now(),
      agentId,
      model,
      prompt,
      completion,
      total: prompt + completion,
    });
    if (this.tokenUsage.length > this.MAX_ENTRIES) {
      this.tokenUsage.splice(0, this.tokenUsage.length - this.MAX_ENTRIES);
    }
  }

  recordError(path: string, statusCode: number, error?: string): void {
    this.errors.push({ ts: Date.now(), path, statusCode, error });
    if (this.errors.length > this.MAX_ENTRIES) {
      this.errors.splice(0, this.errors.length - this.MAX_ENTRIES);
    }
  }

  getLatencyHistogram(since?: number, agentId?: string, path?: string): LatencyHistogram {
    let entries = this.latencies;
    if (since) entries = entries.filter((e) => e.ts >= since);
    if (agentId) entries = entries.filter((e) => e.agentId === agentId);
    if (path) entries = entries.filter((e) => e.path === path);

    const values = entries.map((e) => e.ms).sort((a, b) => a - b);
    if (values.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0, avg: 0, min: 0, max: 0 };

    const percentile = (p: number) => values[Math.floor(values.length * p)] || 0;

    return {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      count: values.length,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: values[0]!,
      max: values[values.length - 1]!,
    };
  }

  getTokenUsage(since?: number, agentId?: string): {
    totalPrompt: number;
    totalCompletion: number;
    totalTokens: number;
    byModel: Record<string, number>;
    byAgent: Record<string, number>;
    count: number;
  } {
    let entries = this.tokenUsage;
    if (since) entries = entries.filter((e) => e.ts >= since);
    if (agentId) entries = entries.filter((e) => e.agentId === agentId);

    const byModel: Record<string, number> = {};
    const byAgent: Record<string, number> = {};

    let totalPrompt = 0;
    let totalCompletion = 0;

    for (const e of entries) {
      totalPrompt += e.prompt;
      totalCompletion += e.completion;
      byModel[e.model] = (byModel[e.model] || 0) + e.total;
      byAgent[e.agentId] = (byAgent[e.agentId] || 0) + e.total;
    }

    return {
      totalPrompt,
      totalCompletion,
      totalTokens: totalPrompt + totalCompletion,
      byModel,
      byAgent,
      count: entries.length,
    };
  }

  getErrorRate(since?: number, path?: string): ErrorRate {
    let errors = this.errors;
    if (since) errors = errors.filter((e) => e.ts >= since);
    if (path) errors = errors.filter((e) => e.path === path);

    // Count total requests in same period from latencies
    let total = this.latencies.length + errors.length;
    if (since) {
      total = this.latencies.filter((e) => e.ts >= since).length + errors.length;
    }

    const errorCount = errors.length;
    return {
      total,
      errors: errorCount,
      rate: total > 0 ? errorCount / total : 0,
    };
  }
}

export const metricsCollector = new MetricsCollector();
