import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  model: text('model').notNull(),
  fallbackModel: text('fallback_model'),
  systemPrompt: text('system_prompt').notNull().default('You are a helpful assistant.'),
  tools: text('tools').notNull().default('[]'),
  maxIterations: integer('max_iterations').default(10),
  timeoutMs: integer('timeout_ms').default(120000),
  state: text('state').notNull().default('idle'),
  tags: text('tags').default('[]'),
  metadata: text('metadata').default('{}'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
  updatedAt: text('updated_at').notNull().default("datetime('now')"),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  channelId: text('channel_id'),
  status: text('status').notNull().default('active'),
  tokensUsed: integer('tokens_used').default(0),
  messageCount: integer('message_count').default(0),
  createdAt: text('created_at').notNull().default("datetime('now')"),
  updatedAt: text('updated_at').notNull().default("datetime('now')"),
  lastActive: text('last_active').notNull().default("datetime('now')"),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id),
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  toolCalls: text('tool_calls'),
  toolResults: text('tool_results'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  model: text('model'),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
});

export const tools = sqliteTable('tools', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  schema: text('schema').notNull(),
  category: text('category').default('system'),
  timeoutMs: integer('timeout_ms').default(30000),
  maxOutputBytes: integer('max_output_bytes').default(1000000),
  createdAt: text('created_at').notNull().default("datetime('now')"),
});

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  cronExpr: text('cron_expr').notNull(),
  task: text('task').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastRun: text('last_run'),
  nextRun: text('next_run'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
});

export const memoryEntries = sqliteTable('memory_entries', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  category: text('category').default('general'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
  updatedAt: text('updated_at').notNull().default("datetime('now')"),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').notNull().default('["*"]'),
  createdAt: text('created_at').notNull().default("datetime('now')"),
});
