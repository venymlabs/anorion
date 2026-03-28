#!/usr/bin/env bun
// anorion setup — CLI onboarding wizard
// Run: bun run scripts/setup.ts (or `anorion setup`)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROVIDERS, testProvider, listConfiguredProviders, resolveModel } from '../src/llm/providers';

// ── TTY helpers ──

async function prompt(question: string, defaultValue?: string): Promise<string> {
  process.stdout.write(`\n${question}${defaultValue ? ` [${defaultValue}]` : ''}: `);
  const line = await readline();
  return line.trim() || defaultValue || '';
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = await prompt(`${question} (${defaultYes ? 'Y/n' : 'y/N'})`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function choose(question: string, options: string[]): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  const answer = parseInt(await prompt('Choose'));
  return isNaN(answer) ? 0 : answer - 1;
}

function readline(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once('data', (data) => resolve(data.toString().trim()));
  });
}

function banner(text: string) {
  const line = '═'.repeat(text.length + 4);
  console.log(`\n╔${line}╗`);
  console.log(`║  ${text}  ║`);
  console.log(`╚${line}╝\n`);
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

// ── Main Flow ──

async function main() {
  banner('ANORION SETUP');
  console.log('Welcome to Anorion — the open-source agent gateway.');
  console.log('This wizard will help you get started in under 2 minutes.\n');

  const config: Record<string, any> = {};

  // ── Step 1: Gateway Basics ──
  section('1. Gateway Configuration');
  config.gateway = {
    host: await prompt('Host', '0.0.0.0'),
    port: parseInt(await prompt('Port', '4250')),
    apiKeys: [],
    database: './data/anorion.db',
  };

  // ── Step 2: LLM Provider ──
  section('2. LLM Provider');
  console.log('Available providers:\n');

  const configured = listConfiguredProviders();
  for (const p of configured) {
    console.log(`  ${p.icon} ${p.name.padEnd(20)} ${p.configured ? '✅ configured' : '⬜ no API key'}`);
  }

  const providerNames = PROVIDERS.map((p) => `${p.icon} ${p.name}`);
  const providerIdx = await choose('Select your primary LLM provider:', providerNames);
  const selectedProvider = PROVIDERS[providerIdx];

  if (!process.env[selectedProvider.envKey]) {
    const key = await prompt(`Enter your ${selectedProvider.name} API key (${selectedProvider.envKey})`);
    if (key) {
      config.gateway._envHints = config.gateway._envHints || {};
      config.gateway._envHints[selectedProvider.envKey] = key;
    }
  }

  // Model selection
  if (selectedProvider.popularModels.length > 0) {
    const modelIdx = await choose(
      `Select model for ${selectedProvider.name}:`,
      selectedProvider.popularModels,
    );
    config.agents = {
      defaultModel: `${selectedProvider.id}/${selectedProvider.popularModels[modelIdx] || selectedProvider.defaultModel}`,
    };
  } else {
    const model = await prompt(`Model name for ${selectedProvider.name}`, selectedProvider.defaultModel);
    config.agents = { defaultModel: `${selectedProvider.id}/${model}` };
  }

  // ── Step 3: Agent Defaults ──
  section('3. Agent Defaults');
  config.agents = {
    ...config.agents,
    dir: './agents',
    defaultTimeoutMs: parseInt(await prompt('Default agent timeout (ms)', '120000')),
    maxSubagents: parseInt(await prompt('Max concurrent sub-agents', '5')),
    idleTimeoutMs: 1800000,
  };

  // Fallback model
  if (await confirm('Configure a fallback model?', false)) {
    const fbProviderIdx = await choose('Fallback provider:', providerNames);
    const fbProvider = PROVIDERS[fbProviderIdx];
    const fbModelIdx = await choose(`Fallback model for ${fbProvider.name}:`, fbProvider.popularModels);
    config.agents.fallbackModel = `${fbProvider.id}/${fbProvider.popularModels[fbModelIdx] || fbProvider.defaultModel}`;
  }

  // ── Step 4: Channels ──
  section('4. Channels');
  config.channels = {};

  if (await confirm('Enable Telegram channel?', false)) {
    config.channels.telegram = {
      enabled: true,
      botToken: await prompt('Telegram bot token'),
      allowedUsers: (await prompt('Allowed user IDs (comma-separated)')).split(',').map((s) => s.trim()).filter(Boolean),
      defaultAgent: 'example',
    };
  }

  if (await confirm('Enable Webhook channel?', false)) {
    config.channels.webhook = {
      enabled: true,
      inboundSecret: await prompt('Webhook secret', 'anorion-webhook-' + Math.random().toString(36).slice(2, 10)),
      outboundUrls: [],
      allowedIps: [],
    };
  }

  // ── Step 5: Features ──
  section('5. Features');
  config.tokenBudget = {
    enabled: await confirm('Enable token budgets?', true),
    sessionLimit: 500000,
    dailyLimit: 2000000,
    globalDailyLimit: 10000000,
    mode: 'enforce',
  };

  config.audit = {
    enabled: await confirm('Enable audit logging?', true),
    retentionDays: 90,
  };

  config.metrics = {
    enabled: await confirm('Enable Prometheus metrics (/metrics)?', true),
  };

  config.skills = {
    dir: './skills',
    watch: await confirm('Enable skill hot-reload?', true),
  };

  config.pipelines = {
    dir: './pipelines.yaml',
  };

  // ── Step 6: Create example agent ──
  section('6. Example Agent');

  if (await confirm('Create an example agent?', true)) {
    const agentName = await prompt('Agent name', 'assistant');
    const agentPrompt = await prompt('System prompt', 'You are a helpful AI assistant with access to tools. Be concise and direct.');

    if (!existsSync('./agents')) mkdirSync('./agents', { recursive: true });

    const agentYaml = stringifyYaml({
      name: agentName,
      model: config.agents.defaultModel,
      fallbackModel: config.agents.fallbackModel || undefined,
      systemPrompt: agentPrompt,
      tools: ['echo', 'shell', 'http-request', 'file-read', 'file-write', 'web-search', 'memory-save', 'memory-search', 'memory-list'],
      maxIterations: 10,
      timeoutMs: config.agents.defaultTimeoutMs,
    });

    writeFileSync(`./agents/${agentName}.yaml`, agentYaml);
    console.log(`  ✅ Created agents/${agentName}.yaml`);
  }

  // ── Step 7: Test Connection ──
  section('7. Connection Test');

  if (await confirm('Test LLM connection now?', true)) {
    console.log(`  Testing ${selectedProvider.name}...`);
    const result = await testProvider(selectedProvider.id, config.agents.defaultModel.split('/').pop());
    if (result.ok) {
      console.log(`  ✅ Connected! Latency: ${result.latencyMs}ms`);
    } else {
      console.log(`  ❌ Failed: ${result.error}`);
    }
  }

  // ── Step 8: Write Config ──
  section('8. Save Configuration');

  // Clean up internal fields
  delete config.gateway._envHints;

  const outputPath = resolve(process.cwd(), 'anorion.yaml');
  const yaml = stringifyYaml({
    gateway: config.gateway,
    agents: config.agents,
    channels: config.channels,
    scheduler: { enabled: true },
    bridge: { enabled: false },
    memory: { provider: 'sqlite', directory: './data/memory' },
    tokenBudget: config.tokenBudget,
    audit: config.audit,
    metrics: config.metrics,
    skills: config.skills,
    pipelines: config.pipelines,
  });

  writeFileSync(outputPath, yaml);
  console.log(`  ✅ Configuration saved to ${outputPath}`);

  // ── Done ──
  banner('SETUP COMPLETE');
  console.log('  Next steps:');
  console.log('');
  console.log('    1. Set your API key:');
  console.log(`       export ${selectedProvider.envKey}=<your-key>`);
  console.log('');
  console.log('    2. Start the gateway:');
  console.log('       bun run index.ts');
  console.log('');
  console.log('    3. Send a message:');
  console.log(`       curl -X POST http://localhost:${config.gateway.port}/api/v1/agents/${config.agents.defaultModel.includes('example') ? 'example' : 'assistant'}/messages \\`);
  console.log(`         -H "Content-Type: application/json" \\`);
  console.log(`         -H "X-API-Key: anorion-dev-key" \\`);
  console.log(`         -d '{"text": "Hello!"}'`);
  console.log('');
  console.log(`  📖 Docs: https://docs.anorion.ai`);
  console.log(`  💬 Discord: https://discord.gg/anorion`);
  console.log('');

  process.exit(0);
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
