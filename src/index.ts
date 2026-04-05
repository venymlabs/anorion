import { loadConfig } from './shared/config';
import { initDatabase } from './shared/db';
import { logger } from './shared/logger';
import { toolRegistry } from './tools/registry';
import { agentRegistry } from './agents/registry';
import { sessionManager } from './agents/session';
import { memoryManager } from './memory/store';
import { channelRouter } from './channels/router';
import { TelegramChannel } from './channels/telegram';
import { WebhookChannel } from './channels/webhook';
import app, { setApiKeys, setBridge, registerBridgeRoutes } from './gateway/server';
import routesV2 from './gateway/routes-v2';
import { skillManager } from './tools/skill-manager';
import { scheduleManager } from './scheduler/cron';
import { tokenBudget } from './shared/token-budget';
import { auditLog } from './shared/audit';
import { eventBus } from './shared/events';
import { loadPipelinesFromFile, listPipelines } from './agents/pipeline';
import { listConfiguredProviders } from './llm/providers';
import { Federator } from './bridge/federator';

import echoTool from './tools/builtin/echo';
import shellTool from './tools/builtin/shell';
import httpRequestTool from './tools/builtin/http-request';
import fileReadTool from './tools/builtin/file-read';
import fileWriteTool from './tools/builtin/file-write';
import webSearchTool from './tools/builtin/web-search';
import { memorySaveTool, memorySearchTool, memoryListTool } from './tools/builtin/memory';
import { spawnAgentTool } from './agents/subagent';

const builtinTools = [
  echoTool, shellTool, httpRequestTool, fileReadTool, fileWriteTool,
  webSearchTool, memorySaveTool, memorySearchTool, memoryListTool, spawnAgentTool,
];

// ── Bootstrap ──

async function main() {
  logger.info('Anorion starting...');

  // 1. Load config
  const config = loadConfig();
  logger.info({ port: config.gateway.port }, 'Config loaded');

  // 2. Init database
  const database = initDatabase(config.gateway.database);

  // 3. Load agents from directory
  if (config.agents.dir) {
    agentRegistry.setDb(database.raw, database.prepared);
    memoryManager.setDb(database.raw);
    sessionManager.setDb(database.db, database.prepared);
    await agentRegistry.loadFromDirectory(config.agents.dir);
    logger.info({ agents: agentRegistry.list().map(a => a.name) }, 'Agents loaded from directory');
  }

  // 4. Register builtin tools
  for (const tool of builtinTools) {
    try {
      toolRegistry.register(tool);
    } catch {
      // Already registered — skip
    }
  }
  logger.info({ tools: builtinTools.map(t => t.name) }, 'Builtin tools registered');

  // 5. Set API keys
  if (config.gateway.apiKeys.length > 0) {
    setApiKeys(config.gateway.apiKeys);
    logger.info({ keys: config.gateway.apiKeys.map(k => k.name) }, 'API keys configured');
  }

  // 6. Register v2 + bridge routes
  registerBridgeRoutes(app);
  try {
    app.route('/', routesV2);
  } catch {
    // May already be mounted
  }

  // 7. Start HTTP server FIRST (so API is available immediately)
  const server = Bun.serve({
    port: config.gateway.port,
    hostname: config.gateway.host,
    fetch: app.fetch,
  });

  logger.info(`
╔══════════════════════════════════════════════╗
║  Anorion Gateway                             ║
║  http://${config.gateway.host}:${config.gateway.port}                    ║
║  Agents: ${agentRegistry.list().length.toString().padEnd(30)}║
║  Tools:  ${toolRegistry.list().length.toString().padEnd(30)}║
║  Bridge: ${(config.bridge.enabled ? 'enabled' : 'disabled').padEnd(29)}║
╚══════════════════════════════════════════════╝
  `);

  // 8. Register and start channels (after HTTP server is up)
  const channels = config.channels;

  const tgConfig = channels.telegram;
  const tg = new TelegramChannel({
    botToken: tgConfig.botToken,
    allowedUsers: tgConfig.allowedUsers,
    defaultAgent: tgConfig.defaultAgent,
  });
  channelRouter.registerChannel(tg);
  channelRouter.configure({
    routes: [],
    defaultAgent: tgConfig.defaultAgent,
  });

  if (channels.telegram.enabled) {
    // Don't await — Telegram long-polling blocks
    channelRouter.startChannel('telegram').then(() => {
      logger.info('Telegram channel started');
    }).catch((err: Error) => {
      logger.error({ error: err.message }, 'Telegram channel failed to start');
    });
  }

  if (channels.webhook.enabled) {
    const wh = new WebhookChannel({
      inboundSecret: channels.webhook.inboundSecret,
      outboundUrls: channels.webhook.outboundUrls,
    });
    channelRouter.registerChannel(wh);
    await channelRouter.startChannel('webhook');
    logger.info('Webhook channel started');
  }

  // 9. Load pipelines
  const { existsSync } = await import('fs');
  const pipelinesPath = new URL('../../pipelines.yaml', import.meta.url).pathname;
  if (existsSync(pipelinesPath)) {
    loadPipelinesFromFile(pipelinesPath);
    logger.info({ pipelines: listPipelines().length }, 'Pipelines loaded');
  }

  // 10. Bridge / Federation
  if (config.bridge.enabled) {
    const { BridgeServer } = await import('./bridge/server');
    const bridgeServer = new BridgeServer(config.bridge.port, config.bridge.secret);
    const federator = new Federator(crypto.randomUUID(), config.bridge.secret, bridgeServer);
    setBridge(federator);

    for (const peer of config.bridge.peers) {
      await federator.connectPeer(peer.url, peer.secret || '').catch((err: Error) => {
        logger.warn({ url: peer.url, error: err.message }, 'Failed to connect to peer');
      });
    }
    logger.info({ peers: config.bridge.peers.length }, 'Bridge enabled');
  }

  // 11. Scheduler
  if (config.scheduler.enabled) {
    logger.info('Scheduler enabled');
  }

  // 12. Log provider status
  const providers = listConfiguredProviders();
  const configured = providers.filter(p => p.configured);
  logger.info({ providers: configured.map(p => `${p.icon} ${p.name}`) }, 'Configured LLM providers');

  // 13. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await channelRouter.stopAll();
    server.stop(true);
    database.raw.close();
    logger.info('Goodbye');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'Fatal startup error');
  process.exit(1);
});
