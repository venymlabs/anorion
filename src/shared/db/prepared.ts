import type { Database as BunDatabase, Statement } from 'bun:sqlite';

/** Thin wrapper around bun:sqlite prepared statements with lazy init. */
export class PreparedStatements {
  // Agents
  readonly agentInsert: Statement;
  readonly agentUpdate: Statement;
  readonly agentDelete: Statement;
  readonly agentGetById: Statement;
  readonly agentGetByName: Statement;

  // Sessions
  readonly sessionInsert: Statement;
  readonly sessionGetById: Statement;
  readonly sessionListByAgent: Statement;
  readonly sessionSetStatus: Statement;
  readonly sessionUpdateActivity: Statement;

  // Messages
  readonly messageInsert: Statement;
  readonly messageListBySession: Statement;

  // Schedules
  readonly scheduleInsert: Statement;
  readonly scheduleUpdate: Statement;
  readonly scheduleDelete: Statement;
  readonly scheduleSetLastRun: Statement;
  readonly scheduleGetAll: Statement;

  constructor(db: BunDatabase) {
    // Agents
    this.agentInsert = db.prepare(
      `INSERT INTO agents (id, name, model, fallback_model, system_prompt, tools, max_iterations, timeout_ms, state, tags, metadata, created_at, updated_at)
       VALUES ($id, $name, $model, $fallbackModel, $systemPrompt, $tools, $maxIterations, $timeoutMs, $state, $tags, $metadata, $createdAt, $updatedAt)
       ON CONFLICT (name) DO UPDATE SET id=$id, model=$model, fallback_model=$fallbackModel, system_prompt=$systemPrompt, tools=$tools, max_iterations=$maxIterations, timeout_ms=$timeoutMs, state=$state, tags=$tags, metadata=$metadata, updated_at=$updatedAt`,
    );

    this.agentUpdate = db.prepare(
      `UPDATE agents SET name=$name, model=$model, fallback_model=$fallbackModel, system_prompt=$systemPrompt, tools=$tools,
        max_iterations=$maxIterations, timeout_ms=$timeoutMs, tags=$tags, metadata=$metadata, updated_at=$updatedAt
       WHERE id = $id`,
    );

    this.agentDelete = db.prepare(
      `DELETE FROM agents WHERE id = $id`,
    );

    this.agentGetById = db.prepare(
      `SELECT * FROM agents WHERE id = $id`,
    );

    this.agentGetByName = db.prepare(
      `SELECT * FROM agents WHERE name = $name`,
    );

    // Sessions
    this.sessionInsert = db.prepare(
      `INSERT INTO sessions (id, agent_id, channel_id, status, tokens_used, message_count, created_at, updated_at, last_active)
       VALUES ($id, $agentId, $channelId, $status, $tokensUsed, $messageCount, $createdAt, $updatedAt, $lastActive)`,
    );

    this.sessionGetById = db.prepare(
      `SELECT * FROM sessions WHERE id = $id`,
    );

    this.sessionListByAgent = db.prepare(
      `SELECT * FROM sessions WHERE agent_id = $agentId ORDER BY last_active DESC`,
    );

    this.sessionSetStatus = db.prepare(
      `UPDATE sessions SET status = $status, updated_at = $updatedAt WHERE id = $id`,
    );

    this.sessionUpdateActivity = db.prepare(
      `UPDATE sessions SET last_active = $lastActive, updated_at = $updatedAt, tokens_used = $tokensUsed, message_count = $messageCount, status = $status
       WHERE id = $id`,
    );

    // Messages
    this.messageInsert = db.prepare(
      `INSERT INTO messages (id, session_id, agent_id, role, content, tool_calls, tool_results, tokens_in, tokens_out, model, duration_ms, created_at)
       VALUES ($id, $sessionId, $agentId, $role, $content, $toolCalls, $toolResults, $tokensIn, $tokensOut, $model, $durationMs, $createdAt)`,
    );

    this.messageListBySession = db.prepare(
      `SELECT * FROM messages WHERE session_id = $sessionId ORDER BY created_at DESC LIMIT $limit`,
    );

    // Schedules
    this.scheduleInsert = db.prepare(
      `INSERT INTO schedules (id, agent_id, name, cron_expr, task, enabled, created_at)
       VALUES ($id, $agentId, $name, $cronExpr, $task, $enabled, $createdAt)`,
    );

    this.scheduleUpdate = db.prepare(
      `UPDATE schedules SET name=$name, cron_expr=$cronExpr, task=$task, enabled=$enabled WHERE id = $id`,
    );

    this.scheduleDelete = db.prepare(
      `DELETE FROM schedules WHERE id = $id`,
    );

    this.scheduleSetLastRun = db.prepare(
      `UPDATE schedules SET last_run = $lastRun WHERE id = $id`,
    );

    this.scheduleGetAll = db.prepare(
      `SELECT * FROM schedules`,
    );
  }
}
