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
import { DiscordChannel } from './channels/discord';
import { WhatsAppChannel } from './channels/whatsapp';
import { SignalChannel } from './channels/signal';
import app, { setBridge, registerBridgeRoutes } from './gateway/server';
import routesV2 from './gateway/routes-v2';
import { skillManager } from './tools/skill-manager';
import { scheduleManager } from './scheduler/cron';
import { tokenBudget } from './shared/token-budget';
import { auditLog } from './shared/audit';
import { eventBus } from './shared/events';
import { loadPipelinesFromFile, listPipelines } from './agents/pipeline';
import { listConfiguredProviders } from './llm/providers';
import { Federator } from './bridge/federator';
import { mcpManager } from './tools/mcp/manager';

import echoTool from './tools/builtin/echo';
import shellTool from './tools/builtin/shell';
import httpRequestTool from './tools/builtin/http-request';
import fileReadTool from './tools/builtin/file-read';
import fileWriteTool from './tools/builtin/file-write';
import webSearchTool from './tools/builtin/web-search';
import { memorySaveTool, memorySearchTool, memoryListTool } from './tools/builtin/memory';
import { speakTool, transcribeTool, listenTool } from './tools/builtin/voice';
import { spawnAgentTool } from './agents/subagent';

const builtinTools = [
  echoTool, shellTool, httpRequestTool, fileReadTool, fileWriteTool,
  webSearchTool, memorySaveTool, memorySearchTool, memoryListTool,
  speakTool, transcribeTool, listenTool, spawnAgentTool,
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
    agentRegistry.setDb(database.db, database.prepared);
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

  // 4b. Connect MCP servers and register their tools
  if (config.mcp?.servers?.length) {
    for (const serverConfig of config.mcp.servers) {
      mcpManager.addServer({
        ...serverConfig,
        transport: serverConfig.transport.type === 'stdio'
          ? { ...serverConfig.transport, env: (serverConfig.transport as { env?: Record<string, unknown> }).env as Record<string, string> | undefined }
          : { ...serverConfig.transport, headers: (serverConfig.transport as { headers?: Record<string, unknown> }).headers as Record<string, string> | undefined },
      });
    }
    const mcpResult = await mcpManager.connectAll();
    logger.info(mcpResult, 'MCP servers connected');
  }

  // 5. Set API keys
  if (config.gateway.apiKeys.length > 0) {
    // API keys are now configured via gateway middleware
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

  if (channels.discord.enabled) {
    const dc = new DiscordChannel({
      botToken: channels.discord.botToken,
      allowedGuilds: channels.discord.allowedGuilds,
      allowedUsers: channels.discord.allowedUsers,
      defaultAgent: channels.discord.defaultAgent,
      maxMessageLength: channels.discord.maxMessageLength,
    });
    channelRouter.registerChannel(dc);
    channelRouter.startChannel('discord').then(() => {
      logger.info('Discord channel started');
    }).catch((err: Error) => {
      logger.error({ error: err.message }, 'Discord channel failed to start');
    });
  }

  if (channels.whatsapp.enabled) {
    const wa = new WhatsAppChannel({
      authDir: channels.whatsapp.authDir,
      allowedNumbers: channels.whatsapp.allowedNumbers,
      allowedGroups: channels.whatsapp.allowedGroups,
      defaultAgent: channels.whatsapp.defaultAgent,
      handleGroups: channels.whatsapp.handleGroups,
      groupPrefix: channels.whatsapp.groupPrefix,
    });
    channelRouter.registerChannel(wa);
    channelRouter.startChannel('whatsapp').then(() => {
      logger.info('WhatsApp channel started');
    }).catch((err: Error) => {
      logger.error({ error: err.message }, 'WhatsApp channel failed to start');
    });
  }

  if (channels.signal.enabled) {
    const sg = new SignalChannel({
      apiUrl: channels.signal.apiUrl,
      phoneNumber: channels.signal.phoneNumber,
      allowedNumbers: channels.signal.allowedNumbers,
      allowedGroups: channels.signal.allowedGroups,
      defaultAgent: channels.signal.defaultAgent,
      pollIntervalMs: channels.signal.pollIntervalMs,
      handleGroups: channels.signal.handleGroups,
      groupPrefix: channels.signal.groupPrefix,
      attachmentDir: channels.signal.attachmentDir,
    });
    channelRouter.registerChannel(sg);
    channelRouter.startChannel('signal').then(() => {
      logger.info('Signal channel started');
    }).catch((err: Error) => {
      logger.error({ error: err.message }, 'Signal channel failed to start');
    });
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
    const bridgeServer = new BridgeServer(String(config.bridge.port), config.bridge.secret);
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

  // 12b. Initialize voice module
  if (config.voice.enabled) {
    try {
      const { voiceConversation } = await import('./voice/conversation');
      logger.info({ provider: config.voice.ttsProvider }, 'Voice module enabled');

      // Periodic cleanup of idle voice sessions every 5 minutes
      setInterval(() => {
        voiceConversation.cleanupIdleSessions(config.voice.conversationSilenceMs || 300_000);
      }, 5 * 60_000);
    } catch {
      logger.warn('Voice module not available');
    }
  }

  // 13. Graceful shutdown
  const shutdown = async (sig: string) => {
    logger.info({ signal: sig }, 'Shutting down...');
    await mcpManager.disconnectAll();
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
