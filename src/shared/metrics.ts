// Prometheus-compatible metrics endpoint for Anorion
// Collects counters, gauges, and histograms in standard Prometheus exposition format

import { agentRegistry } from '../agents/registry';
import { sessionManager } from '../agents/session';
import { toolRegistry } from '../tools/registry';
import { memoryManager } from '../memory/store';
import { tokenBudget } from '../shared/token-budget';

class MetricsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private startTime = Date.now();

  // Counter operations
  inc(name: string, value = 1, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  // Gauge operations
  set(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    this.gauges.set(key, value);
  }

  // Histogram operations
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    if (!this.histograms.has(key)) this.histograms.set(key, []);
    this.histograms.get(key)!.push(value);
    // Keep last 10000 observations per metric to cap memory
    const arr = this.histograms.get(key)!;
    if (arr.length > 10000) arr.splice(0, arr.length - 10000);
  }

  /** Generate Prometheus exposition format text */
  render(): string {
    const lines: string[] = [];

    // Process info
    lines.push('# HELP anorion_up Whether Anorion is running');
    lines.push('# TYPE anorion_up gauge');
    lines.push(`anorion_up 1`);
    lines.push('');

    lines.push('# HELP anorion_uptime_seconds Gateway uptime in seconds');
    lines.push('# TYPE anorion_uptime_seconds gauge');
    lines.push(`anorion_uptime_seconds ${((Date.now() - this.startTime) / 1000).toFixed(0)}`);
    lines.push('');

    // Runtime gauges
    const mem = process.memoryUsage();
    lines.push('# HELP anorion_memory_rss_bytes Process RSS memory in bytes');
    lines.push('# TYPE anorion_memory_rss_bytes gauge');
    lines.push(`anorion_memory_rss_bytes ${mem.rss}`);
    lines.push('');

    lines.push('# HELP anorion_memory_heap_used_bytes Heap memory used in bytes');
    lines.push('# TYPE anorion_memory_heap_used_bytes gauge');
    lines.push(`anorion_memory_heap_used_bytes ${mem.heapUsed}`);
    lines.push('');

    lines.push('# HELP anorion_agents_total Total registered agents');
    lines.push('# TYPE anorion_agents_total gauge');
    lines.push(`anorion_agents_total ${agentRegistry.list().length}`);
    lines.push('');

    lines.push('# HELP anorion_tools_total Total registered tools');
    lines.push('# TYPE anorion_tools_total gauge');
    lines.push(`anorion_tools_total ${toolRegistry.list().length}`);
    lines.push('');

    // Token budget
    const globalUsage = tokenBudget.getGlobalUsage();
    lines.push('# HELP anorion_tokens_daily_used Global daily tokens used');
    lines.push('# TYPE anorion_tokens_daily_used gauge');
    lines.push(`anorion_tokens_daily_used ${globalUsage.dailyUsed}`);
    lines.push('');

    lines.push('# HELP anorion_tokens_daily_limit Global daily token limit');
    lines.push('# TYPE anorion_tokens_daily_limit gauge');
    lines.push(`anorion_tokens_daily_limit ${globalUsage.dailyLimit}`);
    lines.push('');

    // Counters
    for (const [key, value] of this.counters) {
      const { name, labels } = this.parseKey(key);
      lines.push(`# HELP ${name} ${name} counter`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
      lines.push('');
    }

    // Gauges
    for (const [key, value] of this.gauges) {
      const { name, labels } = this.parseKey(key);
      lines.push(`# HELP ${name} ${name} gauge`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${this.formatLabels(labels)} ${value}`);
      lines.push('');
    }

    // Histograms
    for (const [key, values] of this.histograms) {
      const { name, labels } = this.parseKey(key);
      lines.push(`# HELP ${name} ${name} histogram`);
      lines.push(`# TYPE ${name} histogram`);
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const count = sorted.length;
      const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
      for (const b of buckets) {
        const le = sorted.filter(v => v <= b).length;
        lines.push(`${name}_bucket${this.formatLabels({ ...labels, le: String(b) })} ${le}`);
      }
      lines.push(`${name}_bucket${this.formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${name}_sum${this.formatLabels(labels)} ${sum}`);
      lines.push(`${name}_count${this.formatLabels(labels)} ${count}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private labelKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return `${name}{${sorted.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  }

  private parseKey(key: string): { name: string; labels: Record<string, string> } {
    const braceIdx = key.indexOf('{');
    if (braceIdx === -1) return { name: key, labels: {} };
    const name = key.slice(0, braceIdx);
    const labelStr = key.slice(braceIdx + 1, -1);
    const labels: Record<string, string> = {};
    for (const pair of labelStr.split(',')) {
      const [k, v] = pair.split('=');
      if (k && v) labels[k.trim()] = v.trim().replace(/^"|"$/g, '');
    }
    return { name, labels };
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  }
}

export const metrics = new MetricsCollector();

// Auto-instrument: listen to events and record metrics
import { eventBus } from '../shared/events';

eventBus.on('agent:response', (data) => {
  metrics.inc('anorion_agent_messages_total', 1, { agent_id: data.agentId });
  metrics.observe('anorion_agent_response_duration_seconds', data.durationMs / 1000, { agent_id: data.agentId });
});

eventBus.on('agent:error', (data) => {
  metrics.inc('anorion_agent_errors_total', 1, { agent_id: data.agentId });
});

eventBus.on('tool:executed', (data) => {
  metrics.inc('anorion_tool_executions_total', 1, { tool_name: data.toolName, success: String(data.success) });
  metrics.observe('anorion_tool_duration_seconds', data.durationMs / 1000, { tool_name: data.toolName });
});

eventBus.on('token:usage', (data) => {
  metrics.inc('anorion_tokens_total', data.promptTokens + data.completionTokens, { agent_id: data.agentId, model: data.model });
});

eventBus.on('session:created', () => {
  metrics.inc('anorion_sessions_created_total');
});

eventBus.on('bridge:peer:connected', () => {
  metrics.inc('anorion_bridge_peer_connections_total');
});

eventBus.on('bridge:message:forwarded', () => {
  metrics.inc('anorion_bridge_messages_forwarded_total');
});

eventBus.on('schedule:executed', (data) => {
  metrics.inc('anorion_schedule_executions_total', 1, { success: String(data.success) });
});
