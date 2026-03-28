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

