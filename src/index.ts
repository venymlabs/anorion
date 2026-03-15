import { loadConfig, type AnorionConfig } from './shared/config';
import { initDatabase } from './shared/db';
import { logger } from './shared/logger';
import { toolRegistry } from './tools/registry';
import { agentRegistry } from './agents/registry';
import { sessionManager } from './agents/session';
import { channelRouter } from './channels/router';
import { TelegramChannel } from './channels/telegram';
import app, { setApiKeys, setBridge, registerBridgeRoutes } from './gateway/server';
import { setupWebSocket } from './gateway/ws';
import { serve } from '@hono/node-server';

import echoTool from './tools/builtin/echo';
import shellTool from './tools/builtin/shell';
import httpRequestTool from './tools/builtin/http-request';
import fileReadTool from './tools/builtin/file-read';
import fileWriteTool from './tools/builtin/file-write';
import webSearchTool from './tools/builtin/web-search';
import { memorySaveTool, memorySearchTool, memoryListTool } from './tools/builtin/memory';
import { spawnAgentTool } from './agents/subagent';
import { scheduleManager } from './scheduler/cron';

const builtinTools = [echoTool, shellTool, httpRequestTool, fileReadTool, fileWriteTool, webSearchTool, memorySaveTool, memorySearchTool, memoryListTool, spawnAgentTool];

async function main() {
  logger.info('🔥 Anorion Gateway starting...');

  // Load config
  const config = loadConfig();
  logger.info({ port: config.gateway.port }, 'Config loaded');

  // Init database
  const db = initDatabase(config.gateway.database);
  agentRegistry.setDb(db);
  sessionManager.setDb(db);

  // Session lifecycle
  sessionManager.setIdleTimeout(config.agents.idleTimeoutMs);
  sessionManager.startIdleChecker();

  // Register built-in tools
  for (const tool of builtinTools) {
    toolRegistry.register(tool);
  }
  logger.info({ count: builtinTools.length }, 'Built-in tools registered');

  // Load agents from directory
  await agentRegistry.loadFromDirectory(config.agents.dir);

  // Bind tools to loaded agents
  for (const agent of agentRegistry.list()) {
    if (agent.tools.length > 0) {
      toolRegistry.bindTools(agent.id, agent.tools);
    }
  }

  // Create default example agent if none exist
  if (agentRegistry.list().length === 0) {
    logger.info('No agents found, creating default example agent');
    const agent = await agentRegistry.create({
      name: 'example',
      model: config.agents.defaultModel,
      systemPrompt: 'You are a helpful assistant. You have access to tools.',
      tools: ['echo', 'shell', 'http-request', 'file-read', 'file-write', 'web-search', 'memory-save', 'memory-search', 'memory-list', 'spawn-agent'],
      maxIterations: 10,
    });
    toolRegistry.bindTools(agent.id, agent.tools);
  }

  // Setup channel router
  channelRouter.configure({
    routes: [],
    defaultAgent: config.channels.telegram?.defaultAgent || 'example',
  });

  // Setup Telegram channel
  if (config.channels.telegram?.enabled) {
    const telegramChannel = new TelegramChannel({
      botToken: config.channels.telegram.botToken,
      allowedUsers: config.channels.telegram.allowedUsers,
      defaultAgent: config.channels.telegram.defaultAgent || 'example',
    });
    channelRouter.registerChannel(telegramChannel);
    await telegramChannel.start();
  }

  // Set API keys
  setApiKeys(config.gateway.apiKeys.map((k) => ({ name: k.name, key: k.key, scopes: k.scopes })));

  // Init scheduler
  scheduleManager.setDb(db);
  await scheduleManager.loadAll();

  // Start server
  const server = serve({ fetch: app.fetch, port: config.gateway.port }, (info) => {
    logger.info({ port: info.port, host: config.gateway.host }, '🚀 Anorion Gateway ready');
    logger.info(`   Health:   http://${config.gateway.host}:${config.gateway.port}/health`);
    logger.info(`   Agents:   http://${config.gateway.host}:${config.gateway.port}/api/v1/agents`);
    logger.info(`   Tools:    http://${config.gateway.host}:${config.gateway.port}/api/v1/tools`);
    logger.info(`   Channels: http://${config.gateway.host}:${config.gateway.port}/api/v1/channels`);
  });

  // Setup WebSocket
  setupWebSocket(server);

  // Bridge (opt-in)
  if (config.bridge.enabled) {
    const { BridgeServer } = await import('./bridge/server');
    const { Federator } = await import('./bridge/federator');
    const gatewayId = crypto.randomUUID();
    const bridgeServer = new BridgeServer(gatewayId, config.bridge.secret);
    bridgeServer.attach(server);
    const federator = new Federator(gatewayId, config.bridge.secret, bridgeServer);
    setBridge(federator);
    registerBridgeRoutes(app);

    // Connect to configured peers
    for (const peer of config.bridge.peers) {
      await federator.connectPeer(peer.url, peer.secret || config.bridge.secret);
    }

    logger.info('🌉 Bridge enabled — federated gateway mode active');
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    sessionManager.stopIdleChecker();
    scheduleManager.shutdown();
    await channelRouter.stopAll();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ error: err.message }, 'Failed to start');
  process.exit(1);
});
