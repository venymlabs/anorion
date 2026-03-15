import { loadConfig } from './shared/config';
import { initDatabase } from './shared/db';
import { logger } from './shared/logger';
import { toolRegistry } from './tools/registry';
import { agentRegistry } from './agents/registry';
import { sessionManager } from './agents/session';
import app, { setApiKeys } from './gateway/server';
import { setupWebSocket } from './gateway/ws';
import { serve } from '@hono/node-server';
import echoTool from './tools/builtin/echo';

async function main() {
  logger.info('🔥 Anorion Gateway starting...');

  // Load config
  const config = loadConfig();
  logger.info({ port: config.gateway.port }, 'Config loaded');

  // Init database
  const db = initDatabase(config.gateway.database);
  agentRegistry.setDb(db);
  sessionManager.setDb(db);

  // Register built-in tools
  toolRegistry.register(echoTool);

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
      model: 'openai/gpt-4o',
      systemPrompt: 'You are a helpful assistant. You have access to tools.',
      tools: ['echo'],
      maxIterations: 10,
    });
    toolRegistry.bindTools(agent.id, agent.tools);
  }

  // Set API keys
  setApiKeys(config.gateway.apiKeys.map((k) => ({ name: k.name, key: k.key, scopes: k.scopes })));

  // Start server
  const server = serve({ fetch: app.fetch, port: config.gateway.port }, (info) => {
    logger.info({ port: info.port, host: config.gateway.host }, '🚀 Anorion Gateway ready');
    logger.info(`   Health: http://${config.gateway.host}:${config.gateway.port}/health`);
    logger.info(`   Agents: http://${config.gateway.host}:${config.gateway.port}/api/v1/agents`);
    logger.info(`   Tools:  http://${config.gateway.host}:${config.gateway.port}/api/v1/tools`);
  });

  // Setup WebSocket
  setupWebSocket(server);
}

main().catch((err) => {
  logger.error({ error: err.message }, 'Failed to start');
  process.exit(1);
});
