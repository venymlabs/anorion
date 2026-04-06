#!/usr/bin/env bun
// Anorion CLI — management commands
// Usage: bun run scripts/cli.ts <command> [args]

import { existsSync, mkdirSync } from 'fs';
import { PROVIDERS, listConfiguredProviders, testProvider } from '../src/llm/providers';

const command = process.argv[2];

// ── Helpers ──

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── Commands ──

async function status() {
  console.log('🔥 Anorion Gateway Status\n');
  try {
    const res = await fetch('http://localhost:4250/health');
    const data = (await res.json()) as any;
    console.log(`  Status:    ✅ Running`);
    console.log(`  Uptime:    ${formatUptime(data.uptime)}`);
    console.log(`  Agents:    ${data.agents}`);
    console.log(`  Timestamp: ${data.timestamp}`);
    try {
      const metrics = await fetch('http://localhost:4250/metrics');
      if (metrics.ok) {
        const text = await metrics.text();
        const memMatch = text.match(/anorion_memory_rss_bytes (\d+)/);
        if (memMatch) console.log(`  Memory:    ${formatBytes(parseInt(memMatch[1]!))}`);
      }
    } catch {}
  } catch {
    console.log('  Status:    ❌ Not running');
    console.log('  Start with: bun run index.ts');
  }
}

async function doctor() {
  console.log('🔥 Anorion Doctor — Diagnostic Check\n');
  let issues = 0;

  // 1. Bun
  console.log('  [1/6] Runtime...');
  try {
    const proc = Bun.spawn(['bun', '--version'], { stdout: 'pipe' });
    const version = await new Response(proc.stdout).text();
    console.log(`  ✅ Bun ${version.trim()}`);
  } catch {
    console.log('  ❌ Bun not found');
    issues++;
  }

  // 2. Config
  console.log('  [2/6] Configuration...');
  if (existsSync('anorion.yaml')) {
    console.log('  ✅ anorion.yaml found');
  } else {
    console.log('  ⚠️  No anorion.yaml — run: bun run scripts/setup.ts');
    issues++;
  }

  // 3. Dependencies
  console.log('  [3/6] Dependencies...');
  if (existsSync('node_modules')) {
    console.log('  ✅ node_modules exists');
  } else {
    console.log('  ⚠️  No node_modules — run: bun install');
    issues++;
  }

  // 4. Data dir
  console.log('  [4/6] Data directory...');
  mkdirSync('./data', { recursive: true });
  console.log('  ✅ ./data ready');

  // 5. LLM providers
  console.log('  [5/6] LLM Providers...');
  const providers = listConfiguredProviders();
  const configured = providers.filter((p) => p.configured);
  if (configured.length === 0) {
    console.log('  ⚠️  No LLM providers configured. Set an API key:');
    providers.slice(0, 5).forEach((p) => {
      console.log(`        export ${p.id.toUpperCase().replace(/-/g, '_')}_API_KEY=...`);
    });
    issues++;
  } else {
    configured.forEach((p) => {
      console.log(`  ✅ ${p.icon} ${p.name} (${p.models.length} models)`);
    });
  }

  // 6. Connection test
  console.log('  [6/6] Connection test...');
  for (const p of configured.slice(0, 3)) {
    const result = await testProvider(p.id);
    if (result.ok) {
      console.log(`  ✅ ${p.icon} ${p.name}: ${result.latencyMs}ms`);
    } else {
      console.log(`  ❌ ${p.icon} ${p.name}: ${result.error}`);
      issues++;
    }
  }

  console.log('');
  if (issues === 0) {
    console.log('  🎉 All checks passed! Ready to go.');
  } else {
    console.log(`  ⚠️  ${issues} issue(s) found. Fix them above.`);
  }
}

async function providers() {
  console.log('🔥 LLM Provider Status\n');
  const all = listConfiguredProviders();
  for (const p of all) {
    const status = p.configured ? '✅' : '⬜';
    console.log(`  ${status} ${p.icon} ${p.name}`);
    if (p.configured) {
      console.log(`     Key: ${p.id.toUpperCase()}_API_KEY`);
      console.log(`     Models: ${p.models.join(', ') || 'custom'}`);
    } else {
      console.log(`     Set: export ${p.id.toUpperCase()}_API_KEY=<key>`);
    }
    console.log('');
  }
  console.log(`  Total: ${all.filter((p) => p.configured).length}/${all.length} configured`);
}

async function models() {
  console.log('🔥 Available Models\n');
  for (const p of PROVIDERS) {
    if (!process.env[p.envKey]) continue;
    console.log(`  ${p.icon} ${p.name}:`);
    for (const m of p.popularModels) {
      console.log(`     • ${m}`);
    }
    console.log('');
  }
  console.log('  Usage: "provider/model" e.g. "openai/gpt-4o", "zai/glm-5.1"');
}

async function help() {
  console.log('🔥 Anorion CLI\n');
  console.log('Usage: bun run scripts/cli.ts <command>\n');
  console.log('Commands:');
  console.log('  status     Check if gateway is running');
  console.log('  doctor     Run diagnostic checks');
  console.log('  providers  List LLM provider status');
  console.log('  models     List available models');
  console.log('  help       Show this help');
  console.log('');
  console.log('Setup:');
  console.log('  bun run scripts/setup.ts         First-time setup wizard');
}

// ── Router ──

const commands: Record<string, () => Promise<void>> = { status, doctor, providers, models };

if (!command || command === 'help' || command === '--help') {
  help();
} else if (commands[command]) {
  commands[command]();
} else {
  console.log(`Unknown command: ${command}`);
  help();
  process.exit(1);
}
