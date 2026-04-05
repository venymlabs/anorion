#!/usr/bin/env node
// Anorion CLI — production-ready command-line interface
// Works with both Node.js and Bun runtimes

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';

// ── Helpers ──────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const pkgPath = resolve(dirname(import.meta.url.replace('file://', '')), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.2.1';
  } catch {
    return pkg.version || '0.2.1';
  }
}

function getAnorionDir(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'anorion.yaml'))) return cwd;
  // Walk up directories
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    if (existsSync(resolve(parent, 'anorion.yaml'))) return parent;
    dir = parent;
  }
  return cwd;
}

function bold(text: string) { return pc.bold(text); }
function dim(text: string) { return pc.dim(text); }
function green(text: string) { return pc.green(text); }
function red(text: string) { return pc.red(text); }
function yellow(text: string) { return pc.yellow(text); }
function cyan(text: string) { return pc.cyan(text); }
function magenta(text: string) { return pc.magenta(text); }

function header(text: string) {
  const line = '─'.repeat(52);
  console.log(`\n${pc.red('🔥')} ${bold(text)}\n${dim(line)}`);
}

function error(msg: string) {
  console.error(`\n${red('✖')} ${msg}\n`);
}

function success(msg: string) {
  console.log(`${green('✔')} ${msg}`);
}

function info(msg: string) {
  console.log(`${cyan('●')} ${msg}`);
}

function warn(msg: string) {
  console.log(`${yellow('⚠')}  ${msg}`);
}

// ── ASCII Art ────────────────────────────────────────────────────────

function printBanner() {
  console.log(pc.red(`
  ╔══════════════════════════════════════════╗
  ║   🔥 ${bold('Anorion')} — The Agent Gateway         ║
  ║   v${getVersion().padEnd(33)}║
  ╚══════════════════════════════════════════╝
`));
}

// ── Help ─────────────────────────────────────────────────────────────

function printHelp() {
  printBanner();
  console.log(dim('Usage: anorion <command> [options]\n'));

  const commands = [
    ['init',             'Interactive setup wizard (first-time)'],
    ['start [-d]',       'Start the gateway server (--detach for daemon)'],
    ['stop',             'Stop the daemon'],
    ['restart',          'Restart the daemon'],
    ['status',           'Show gateway status & health'],
    ['config [cmd]',     'Manage configuration (get/set/edit)'],
    ['agent <cmd>',      'Manage agents (list/create/show/delete)'],
    ['chat [--agent id]', 'Interactive REPL chat with an agent'],
    ['channel <cmd>',    'Manage channels (list/enable/disable/test)'],
    ['tool <cmd>',       'List and execute tools'],
    ['logs [--lines N]', 'Tail gateway logs'],
    ['version',          'Show version'],
    ['doctor',           'Run diagnostic checks'],
  ];

  console.log(bold('Commands:\n'));
  const maxLen = Math.max(...commands.map(c => c[0].length));
  for (const [cmd, desc] of commands) {
    console.log(`  ${cyan(cmd.padEnd(maxLen + 2))} ${dim(desc)}`);
  }

  console.log(`\n${dim('Docs: https://docs.anorion.ai  •  Discord: https://discord.gg/anorion')}\n`);
}

// ── Command Routing ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

async function run() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'init':       return cmdInit();
    case 'start':      return cmdStart();
    case 'stop':       return cmdStop();
    case 'restart':    return cmdRestart();
    case 'status':     return cmdStatus();
    case 'config':     return cmdConfig();
    case 'agent':      return cmdAgent();
    case 'chat':       return cmdChat();
    case 'channel':    return cmdChannel();
    case 'tool':       return cmdTool();
    case 'logs':       return cmdLogs();
    case 'version':
    case '-v':
    case '--version':
      console.log(`anorion v${getVersion()}`);
      return;
    case 'doctor':     return cmdDoctor();
    default:
      error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

run().catch((err: Error) => {
  error(err.message);
  process.exit(1);
});

// ── Init Command ─────────────────────────────────────────────────────

async function cmdInit() {
  header('Init — Setup Wizard');
  console.log(dim('This wizard will configure your Anorion instance.\n'));

  const { prompt, confirm, choose } = await import('./interactive.js');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { stringify: stringifyYaml } = await import('yaml');

  const config: Record<string, any> = {};

  // 1. Project
  config.gateway = {
    host: await prompt('Host', '0.0.0.0'),
    port: parseInt(await prompt('Port', '4250')),
    apiKeys: [{ name: 'admin', key: 'anorion-dev-key', scopes: ['*'] }],
    database: './data/anorion.db',
  };

  // 2. LLM Provider
  console.log('\nAvailable LLM providers:');
  const providers = [
    '⚡ z.ai',
    '🟢 OpenAI',
    '🟣 Anthropic',
    '🔵 Google AI',
    '🌀 Mistral',
    '⚡ Groq',
    '🔍 DeepSeek',
    '𝕏 xAI (Grok)',
    '🌐 OpenRouter',
    '🦙 Ollama (Local)',
  ];
  const pIdx = await choose('Select primary LLM provider:', providers);
  const providerMap = ['zai','openai','anthropic','google','mistral','groq','deepseek','xai','openrouter','ollama'];
  const providerId = providerMap[pIdx] || 'openai';

  const providerModels: Record<string, string[]> = {
    zai: ['glm-5', 'glm-5-turbo', 'glm-5.1'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    mistral: ['mistral-large-latest', 'mistral-medium-latest'],
    groq: ['llama-3.3-70b-versatile'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    xai: ['grok-3', 'grok-3-mini'],
    openrouter: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
    ollama: ['llama3.1:70b', 'qwen2.5:72b'],
  };

  const models = providerModels[providerId] || ['default'];
  const defaultModels: Record<string, string> = {
    zai: 'glm-5.1', openai: 'gpt-4o', anthropic: 'claude-sonnet-4-6',
    google: 'gemini-2.5-flash', mistral: 'mistral-large-latest',
    groq: 'llama-3.3-70b-versatile', deepseek: 'deepseek-chat',
    xai: 'grok-3', openrouter: 'anthropic/claude-sonnet-4', ollama: 'llama3.1:70b',
  };

  let model: string;
  if (models.length > 1) {
    const mIdx = await choose('Select model:', models);
    model = models[mIdx] || defaultModels[providerId];
  } else {
    model = models[0] || defaultModels[providerId];
  }

  const fullModel = `${providerId}/${model}`;

  // 3. Agent
  const agentName = await prompt('Agent name', 'assistant');
  const agentPrompt = await prompt('System prompt', 'You are a helpful AI assistant with access to tools. Be concise and direct.');

  // 4. Telegram
  let telegram: any = { enabled: false };
  if (await confirm('Enable Telegram channel?', false)) {
    telegram = {
      enabled: true,
      botToken: await prompt('Telegram bot token'),
      allowedUsers: (await prompt('Allowed user IDs (comma-separated)')).split(',').map(s => s.trim()).filter(Boolean),
      defaultAgent: agentName,
    };
  }

  // 5. Write config
  const yaml = stringifyYaml({
    gateway: config.gateway,
    agents: {
      dir: './agents',
      defaultModel: fullModel,
      defaultTimeoutMs: 120000,
      maxSubagents: 5,
      idleTimeoutMs: 1800000,
    },
    channels: { telegram },
    scheduler: { enabled: true },
    bridge: { enabled: false },
    memory: { provider: 'file', directory: './data/memory' },
  });

  writeFileSync('anorion.yaml', yaml);
  success('Configuration saved to anorion.yaml');

  // 6. Write agent YAML
  mkdirSync('agents', { recursive: true });
  const agentYaml = stringifyYaml({
    name: agentName,
    model: fullModel,
    systemPrompt: agentPrompt,
    tools: ['echo', 'shell', 'http-request', 'file-read', 'file-write', 'web-search', 'memory-save', 'memory-search', 'memory-list'],
    maxIterations: 10,
    timeoutMs: 120000,
  });
  writeFileSync(`agents/${agentName}.yaml`, agentYaml);
  success(`Agent created at agents/${agentName}.yaml`);

  // 7. Write .env template
  const envKey = `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  writeFileSync('.env', `# Anorion Environment\n${envKey}=your-api-key-here\n`);
  success('.env template created');

  console.log(`\n${green('✨ Setup complete!')}\n`);
  console.log(dim('  Next: Set your API key in .env, then run:'));
  console.log(bold('    anorion start\n'));
}

// ── Start Command ────────────────────────────────────────────────────

async function cmdStart() {
  const detach = args.includes('--detach') || args.includes('-d');
  const anorionDir = getAnorionDir();

  if (!existsSync(resolve(anorionDir, 'anorion.yaml'))) {
    error('No anorion.yaml found. Run `anorion init` first.');
    process.exit(1);
  }

  if (detach) {
    return startDaemon(anorionDir);
  }

  // Foreground — spawn the gateway
  console.log(dim(`Starting Anorion gateway from ${anorionDir}...\n`));
  const { spawn } = await import('node:child_process');
  const isBun = existsSync(resolve(anorionDir, 'node_modules')) &&
    process.env.BUN_INSTALL || existsSync('/usr/local/bin/bun');

  const runtime = isBun ? 'bun' : 'node';
  const entry = resolve(anorionDir, 'src/index.ts');

  const child = spawn(runtime, [entry], {
    cwd: anorionDir,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}

async function startDaemon(anorionDir: string) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const anorionHome = resolve(homeDir, '.anorion');
  const pidFile = resolve(anorionHome, 'anorion.pid');
  const logDir = resolve(anorionHome, 'logs');

  // Check if already running
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
    if (isProcessRunning(pid)) {
      error(`Already running (PID ${pid})`);
      process.exit(1);
    }
  }

  const { mkdirSync: mkdir } = await import('node:fs');
  mkdir(logDir, { recursive: true });
  mkdir(anorionHome, { recursive: true });

  const { spawn } = await import('node:child_process');
  const logFile = resolve(logDir, `gateway-${Date.now()}.log`);

  const isBun = existsSync('/usr/local/bin/bun') || existsSync(`${homeDir}/.bun/bin/bun`);
  const runtime = isBun ? 'bun' : 'node';
  const entry = resolve(anorionDir, 'src/index.ts');

  const child = spawn(runtime, [entry], {
    cwd: anorionDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Pipe to log file
  const logStream = (await import('node:fs')).createWriteStream(logFile, { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  child.unref();

  const { writeFileSync } = await import('node:fs');
  writeFileSync(pidFile, String(child.pid));
  writeFileSync(resolve(anorionHome, 'anorion.logfile'), logFile);

  success(`Gateway started (PID ${child.pid})`);
  info(`Logs: ${logFile}`);
  console.log(dim(`  Run ${cyan('anorion logs')} to tail\n`));
}

// ── Stop Command ─────────────────────────────────────────────────────

async function cmdStop() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const pidFile = resolve(homeDir, '.anorion/anorion.pid');

  if (!existsSync(pidFile)) {
    error('Not running (no PID file found)');
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
  if (!isProcessRunning(pid)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(pidFile);
    error('Process not running (stale PID file removed)');
    process.exit(1);
  }

  process.kill(pid, 'SIGTERM');
  info(`Sent SIGTERM to PID ${pid}`);

  // Wait up to 10s
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!isProcessRunning(pid)) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(pidFile);
      success('Gateway stopped');
      return;
    }
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
    warn('Force killed (SIGKILL)');
  } catch { /* already dead */ }

  const { unlinkSync } = await import('node:fs');
  unlinkSync(pidFile);
}

// ── Restart Command ──────────────────────────────────────────────────

async function cmdRestart() {
  info('Restarting gateway...');
  await cmdStop();
  await new Promise(r => setTimeout(r, 1000));
  args.push('--detach');
  await cmdStart();
}

// ── Status Command ───────────────────────────────────────────────────

async function cmdStatus() {
  header('Gateway Status');

  const port = getGatewayPort();

  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json() as any;

    success('Gateway is running');
    console.log(`  ${dim('Uptime:')}    ${formatUptime(data.uptime)}`);
    console.log(`  ${dim('Agents:')}    ${data.agents}`);
    console.log(`  ${dim('URL:')}       http://localhost:${port}`);
    console.log(`  ${dim('Timestamp:')} ${data.timestamp}`);

    // Check PID
    const homeDir = process.env.HOME || '/tmp';
    const pidFile = resolve(homeDir, '.anorion/anorion.pid');
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf-8').trim();
      console.log(`  ${dim('PID:')}       ${pid}`);
    }

    // Memory
    try {
      const mem = process.memoryUsage ? null : null;
      const metricsRes = await fetch(`http://localhost:${port}/metrics`);
      if (metricsRes.ok) {
        const text = await metricsRes.text();
        const memMatch = text.match(/anorion_memory_rss_bytes (\d+)/);
        if (memMatch) console.log(`  ${dim('Memory:')}    ${formatBytes(parseInt(memMatch[1]))}`);
      }
    } catch {}

    // Channels
    try {
      const chRes = await fetch(`http://localhost:${port}/api/v1/channels`);
      if (chRes.ok) {
        const chData = await chRes.json() as any;
        const channels = chData.channels || [];
        if (channels.length > 0) {
          console.log(`  ${dim('Channels:')}  ${channels.map((c: any) => c.name).join(', ')}`);
        }
      }
    } catch {}

  } catch {
    error('Gateway is not running');
    console.log(dim(`  Start with: ${bold('anorion start')}\n`));
  }
}

// ── Config Command ───────────────────────────────────────────────────

async function cmdConfig() {
  const subcmd = args[1];

  if (!subcmd) {
    // Show full config
    const config = loadYamlConfig();
    if (!config) { error('No anorion.yaml found'); return; }
    const { stringify: stringifyYaml } = await import('yaml');
    console.log(stringifyYaml(config));
    return;
  }

  switch (subcmd) {
    case 'get': {
      const key = args[2];
      if (!key) { error('Usage: anorion config get <key>'); return; }
      const config = loadYamlConfig();
      if (!config) { error('No anorion.yaml found'); return; }
      const value = key.split('.').reduce((o: any, k) => o?.[k], config);
      if (value === undefined) { warn(`Key not found: ${key}`); return; }
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
      return;
    }
    case 'set': {
      const key = args[2];
      const value = args[3];
      if (!key || value === undefined) { error('Usage: anorion config set <key> <value>'); return; }
      const config = loadYamlConfig();
      if (!config) { error('No anorion.yaml found'); return; }
      const parts = key.split('.');
      let obj: any = config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      // Try to parse as number or boolean
      let parsed: any = value;
      if (value === 'true') parsed = true;
      else if (value === 'false') parsed = false;
      else if (!isNaN(Number(value))) parsed = Number(value);
      obj[parts[parts.length - 1]] = parsed;

      const { stringify: stringifyYaml, writeFileSync } = await import('yaml');
      const yaml = stringifyYaml(config);
      const { writeFileSync: write } = await import('node:fs');
      write(resolve(getAnorionDir(), 'anorion.yaml'), yaml);
      success(`${key} = ${parsed}`);
      return;
    }
    case 'edit': {
      const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
      const configPath = resolve(getAnorionDir(), 'anorion.yaml');
      const { execSync } = await import('node:child_process');
      execSync(`${editor} ${configPath}`, { stdio: 'inherit' });
      return;
    }
    default:
      error(`Unknown config command: ${subcmd}`);
      console.log(dim('Usage: anorion config [get|set|edit]'));
  }
}

// ── Agent Command ────────────────────────────────────────────────────

async function cmdAgent() {
  const subcmd = args[1];
  const port = getGatewayPort();

  switch (subcmd) {
    case 'list': {
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/agents`);
        const data = await res.json() as any;
        const agents = data.agents || [];
        if (agents.length === 0) { info('No agents configured'); return; }

        header('Agents');
        for (const a of agents) {
          console.log(`  ${green('●')} ${bold(a.name)} ${dim(`(${a.id})`)}`);
          console.log(`    ${dim('Model:')} ${a.model}  ${dim('Tools:')} ${a.tools?.length || 0}`);
          console.log(`    ${dim('State:')} ${a.state}`);
        }
        console.log();
      } catch {
        error('Gateway not running');
      }
      return;
    }

    case 'create': {
      const { prompt, choose } = await import('./interactive.js');
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { stringify: stringifyYaml } = await import('yaml');

      const name = await prompt('Agent name');
      if (!name) { error('Agent name is required'); return; }

      const modelOptions = [
        'zai/glm-5.1', 'openai/gpt-4o', 'openai/gpt-4o-mini',
        'anthropic/claude-sonnet-4-6', 'google/gemini-2.5-flash',
      ];
      const mIdx = await choose('Model:', modelOptions);
      const model = modelOptions[mIdx] || 'openai/gpt-4o';

      const systemPrompt = await prompt('System prompt', 'You are a helpful assistant.');

      mkdirSync(resolve(getAnorionDir(), 'agents'), { recursive: true });
      const yaml = stringifyYaml({
        name, model, systemPrompt,
        tools: ['echo', 'shell', 'http-request', 'file-read', 'file-write', 'web-search'],
        maxIterations: 10, timeoutMs: 120000,
      });
      writeFileSync(resolve(getAnorionDir(), 'agents', `${name}.yaml`), yaml);
      success(`Agent "${name}" created at agents/${name}.yaml`);
      console.log(dim('  Restart gateway to apply changes'));
      return;
    }

    case 'show': {
      const id = args[2];
      if (!id) { error('Usage: anorion agent show <id>'); return; }
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/agents/${id}`);
        if (!res.ok) { error(`Agent not found: ${id}`); return; }
        const data = await res.json() as any;
        const a = data.agent;
        header(`Agent: ${a.name}`);
        console.log(`  ${dim('ID:')}            ${a.id}`);
        console.log(`  ${dim('Model:')}         ${a.model}`);
        console.log(`  ${dim('State:')}         ${a.state}`);
        console.log(`  ${dim('Tools:')}         ${(a.tools || []).join(', ') || 'none'}`);
        console.log(`  ${dim('Max Iters:')}     ${a.maxIterations || 'default'}`);
        console.log(`  ${dim('Timeout:')}       ${a.timeoutMs || 'default'}ms`);
        console.log(`  ${dim('System Prompt:')}`);
        console.log(`    ${a.systemPrompt}`);
        console.log(`  ${dim('Created:')}       ${a.createdAt}`);
        console.log();
      } catch {
        error('Gateway not running');
      }
      return;
    }

    case 'delete': {
      const id = args[2];
      if (!id) { error('Usage: anorion agent delete <id>'); return; }
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/agents/${id}`, { method: 'DELETE' });
        if (!res.ok) { error(`Failed to delete agent: ${id}`); return; }
        success(`Agent "${id}" deleted`);
      } catch {
        error('Gateway not running');
      }
      return;
    }

    default:
      console.log(dim('Usage: anorion agent <list|create|show|delete>'));
  }
}

// ── Chat Command ─────────────────────────────────────────────────────

async function cmdChat() {
  const agentFlag = args.indexOf('--agent');
  const agentId = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  const port = getGatewayPort();

  // Check gateway is running
  try {
    await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    error('Gateway is not running. Start with: anorion start');
    process.exit(1);
  }

  // Resolve agent
  let targetAgent = agentId || 'assistant';
  try {
    const res = await fetch(`http://localhost:${port}/api/v1/agents/${targetAgent}`);
    if (!res.ok) {
      // Try listing
      const listRes = await fetch(`http://localhost:${port}/api/v1/agents`);
      const list = await listRes.json() as any;
      const agents = list.agents || [];
      if (agents.length > 0) {
        targetAgent = agents[0].id;
      } else {
        error('No agents available');
        process.exit(1);
      }
    }
  } catch {
    error('Failed to connect to gateway');
    process.exit(1);
  }

  header(`Chat with ${targetAgent}`);
  console.log(dim('  Type /help for commands, /exit to quit\n'));

  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${green('❯')} `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    if (text === '/exit' || text === '/quit') {
      console.log(dim('\n  Goodbye!\n'));
      process.exit(0);
    }

    if (text === '/help') {
      console.log(dim('  /exit    — Quit chat'));
      console.log(dim('  /help    — Show this help'));
      console.log(dim('  /clear   — Clear screen'));
      console.log(dim('  /agent   — Show current agent\n'));
      rl.prompt();
      return;
    }

    if (text === '/clear') {
      console.clear();
      rl.prompt();
      return;
    }

    if (text === '/agent') {
      console.log(`  ${dim('Agent:')} ${targetAgent}`);
      rl.prompt();
      return;
    }

    // Send message via streaming
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/agents/${targetAgent}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        // Fallback to non-streaming
        const fallbackRes = await fetch(`http://localhost:${port}/api/v1/agents/${targetAgent}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const data = await fallbackRes.json() as any;
        process.stdout.write(`\n${magenta('❯❯')} ${data.content || data.error || 'No response'}\n\n`);
        rl.prompt();
        return;
      }

      // Parse SSE
      process.stdout.write(`\n${magenta('❯❯')} `);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.content) {
                  process.stdout.write(data.content);
                }
                if (data.toolName) {
                  process.stdout.write(dim(`\n  🔧 ${data.toolName}\n  `));
                }
              } catch {}
            }
          }
        }
      }
      process.stdout.write('\n\n');
    } catch (err) {
      error(`Failed: ${(err as Error).message}`);
    }

    rl.prompt();
  });
}

// ── Channel Command ──────────────────────────────────────────────────

async function cmdChannel() {
  const subcmd = args[1];
  const port = getGatewayPort();

  switch (subcmd) {
    case 'list': {
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/channels`);
        const data = await res.json() as any;
        const channels = data.channels || [];
        header('Channels');
        for (const ch of channels) {
          const status = ch.running ? green('●') : red('○');
          console.log(`  ${status} ${ch.name}`);
        }
        console.log();
      } catch {
        error('Gateway not running');
      }
      return;
    }
    case 'enable': {
      const name = args[2];
      if (!name) { error('Usage: anorion channel enable <name>'); return; }
      try {
        await fetch(`http://localhost:${port}/api/v1/channels/${name}/start`, { method: 'POST' });
        success(`Channel "${name}" enabled`);
      } catch { error('Gateway not running'); }
      return;
    }
    case 'disable': {
      const name = args[2];
      if (!name) { error('Usage: anorion channel disable <name>'); return; }
      try {
        await fetch(`http://localhost:${port}/api/v1/channels/${name}/stop`, { method: 'POST' });
        success(`Channel "${name}" disabled`);
      } catch { error('Gateway not running'); }
      return;
    }
    case 'test': {
      const name = args[2] || 'telegram';
      info(`Testing ${name} connection...`);
      try {
        if (name === 'telegram') {
          const config = loadYamlConfig();
          const token = config?.channels?.telegram?.botToken;
          if (!token) { error('Telegram bot token not configured'); return; }
          const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
          const data = await res.json() as any;
          if (data.ok) {
            success(`Connected as @${data.result.username}`);
          } else {
            error(`Failed: ${data.description}`);
          }
        } else {
          const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
          success(`${name} reachable`);
        }
      } catch (err) {
        error(`Connection failed: ${(err as Error).message}`);
      }
      return;
    }
    default:
      console.log(dim('Usage: anorion channel <list|enable|disable|test>'));
  }
}

// ── Tool Command ─────────────────────────────────────────────────────

async function cmdTool() {
  const subcmd = args[1];
  const port = getGatewayPort();

  switch (subcmd) {
    case 'list': {
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/tools`);
        const data = await res.json() as any;
        const tools = data.tools || [];
        header('Tools');
        const categories = new Map<string, any[]>();
        for (const t of tools) {
          const cat = t.category || 'general';
          if (!categories.has(cat)) categories.set(cat, []);
          categories.get(cat)!.push(t);
        }
        for (const [cat, items] of categories) {
          console.log(`  ${bold(cat)}`);
          for (const t of items) {
            console.log(`    ${cyan(t.name.padEnd(20))} ${dim(t.description)}`);
          }
        }
        console.log();
      } catch {
        error('Gateway not running');
      }
      return;
    }
    case 'exec': {
      const toolName = args[2];
      if (!toolName) { error('Usage: anorion tool exec <name> [args]'); return; }
      // This would need the gateway API — for now show info
      info(`Tool execution for "${toolName}" requires gateway API`);
      return;
    }
    default:
      console.log(dim('Usage: anorion tool <list|exec>'));
  }
}

// ── Logs Command ─────────────────────────────────────────────────────

async function cmdLogs() {
  const linesFlag = args.indexOf('--lines') || args.indexOf('-n');
  const numLines = linesFlag >= 0 ? parseInt(args[linesFlag + 1]) : 50;

  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const anorionHome = resolve(homeDir, '.anorion');

  // Check for log file
  const logfilePtr = resolve(anorionHome, 'anorion.logfile');
  let logFile: string | undefined;

  if (existsSync(logfilePtr)) {
    logFile = readFileSync(logfilePtr, 'utf-8').trim();
  }

  // Also check for pino logs
  if (!logFile || !existsSync(logFile)) {
    // Try to find logs in ~/.anorion/logs/
    const logDir = resolve(anorionHome, 'logs');
    if (existsSync(logDir)) {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
      if (files.length > 0) logFile = resolve(logDir, files[0]);
    }
  }

  if (!logFile || !existsSync(logFile)) {
    info('No log files found. Start with --detach to enable logging.');
    return;
  }

  // Show last N lines
  const { execSync } = await import('node:child_process');
  try {
    // Check if tailing requested (no --lines)
    if (!args.includes('--lines') && !args.includes('-n')) {
      info(`Tailing ${logFile} (Ctrl+C to stop)\n`);
      const { spawn } = await import('node:child_process');
      const child = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
      process.on('SIGINT', () => { child.kill(); process.exit(0); });
    } else {
      execSync(`tail -n ${numLines} ${logFile}`, { stdio: 'inherit' });
    }
  } catch (err) {
    error(`Failed to read logs: ${(err as Error).message}`);
  }
}

// ── Doctor Command ───────────────────────────────────────────────────

async function cmdDoctor() {
  header('Doctor — Diagnostic Check');
  let issues = 0;

  // 1. Runtime
  info('[1/5] Runtime...');
  try {
    const { execSync } = await import('node:child_process');
    const bunVer = execSync('bun --version 2>/dev/null || echo ""').toString().trim();
    const nodeVer = process.version;
    if (bunVer) success(`Bun ${bunVer}, Node ${nodeVer}`);
    else success(`Node ${nodeVer} (Bun not found)`);
  } catch {
    success(`Node ${process.version}`);
  }

  // 2. Config
  info('[2/5] Configuration...');
  const anorionDir = getAnorionDir();
  if (existsSync(resolve(anorionDir, 'anorion.yaml'))) {
    success('anorion.yaml found');
  } else {
    warn('No anorion.yaml — run: anorion init');
    issues++;
  }

  // 3. Dependencies
  info('[3/5] Dependencies...');
  if (existsSync(resolve(anorionDir, 'node_modules'))) {
    success('node_modules installed');
  } else {
    warn('No node_modules — run: bun install');
    issues++;
  }

  // 4. Gateway
  info('[4/5] Gateway...');
  const port = getGatewayPort();
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json() as any;
    success(`Running (uptime: ${formatUptime(data.uptime)})`);
  } catch {
    warn('Not running');
    issues++;
  }

  // 5. LLM
  info('[5/5] LLM Providers...');
  const envKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'MISTRAL_API_KEY'];
  const configured = envKeys.filter(k => process.env[k]);
  if (configured.length > 0) {
    success(`${configured.length} provider(s) configured`);
  } else {
    warn('No API keys found in environment');
    issues++;
  }

  console.log();
  if (issues === 0) success('All checks passed! 🎉');
  else warn(`${issues} issue(s) found`);
  console.log();
}

// ── Utilities ────────────────────────────────────────────────────────

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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadYamlConfig(): any {
  const configPath = resolve(getAnorionDir(), 'anorion.yaml');
  if (!existsSync(configPath)) return null;
  try {
    const { parse: parseYaml } = require('yaml');
    return parseYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function getGatewayPort(): number {
  const config = loadYamlConfig();
  return config?.gateway?.port || 4250;
}
