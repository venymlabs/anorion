// Agent Pipelines — chain agents together for multi-step workflows
// Pipeline: Agent A output → Agent B input → Agent C input → final result

import { nanoid } from 'nanoid';
import { sendMessage } from '../agents/runtime';
import { agentRegistry } from '../agents/registry';
import { logger } from '../shared/logger';
import { eventBus } from '../shared/events';

export interface PipelineStep {
  /** Agent ID or name */
  agent: string;
  /** Optional system prompt override for this step */
  systemPrompt?: string;
  /** Optional model override */
  model?: string;
  /** Max iterations for this step */
  maxIterations?: number;
  /** Transform the output before passing to next step */
  transform?: 'raw' | 'json-extract' | 'first-line' | 'last-line';
  /** Prepend to the input */
  prefix?: string;
  /** Append to the input */
  suffix?: string;
  /** Timeout in ms (default: 120000) */
  timeoutMs?: number;
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  steps: PipelineStep[];
  /** Whether to pass all previous step results or just the last one */
  chainMode: 'last-output' | 'all-outputs';
  /** What to do if a step fails */
  onFailure: 'stop' | 'skip' | 'retry';
  /** Max retries per step */
  maxRetries: number;
}

export interface PipelineResult {
  pipelineId: string;
  name: string;
  steps: Array<{
    agent: string;
    input: string;
    output: string;
    durationMs: number;
    tokensUsed?: number;
    success: boolean;
    error?: string;
  }>;
  finalOutput: string;
  totalDurationMs: number;
  success: boolean;
}

const pipelines = new Map<string, PipelineDefinition>();

/** Register a pipeline */
export function registerPipeline(definition: PipelineDefinition): void {
  pipelines.set(definition.name, definition);
  logger.info({ pipeline: definition.name, steps: definition.steps.length }, 'Pipeline registered');
}

/** Register pipelines from a YAML file */
export function loadPipelinesFromFile(filePath: string): void {
  const { readFileSync, existsSync } = require('fs');
  const { parse: parseYaml } = require('yaml');

  if (!existsSync(filePath)) return;
  const raw = readFileSync(filePath, 'utf-8');
  const defs = parseYaml(raw);

  if (Array.isArray(defs)) {
    for (const def of defs) registerPipeline(def);
  } else if (defs.pipelines) {
    for (const def of defs.pipelines) registerPipeline(def);
  }
}

/** Execute a pipeline */
export async function executePipeline(
  name: string,
  input: string,
  sessionId?: string,
): Promise<PipelineResult> {
  const definition = pipelines.get(name);
  if (!definition) throw new Error(`Pipeline not found: ${name}`);

  const result: PipelineResult = {
    pipelineId: nanoid(10),
    name,
    steps: [],
    finalOutput: '',
    totalDurationMs: 0,
    success: false,
  };

  const startTime = Date.now();
  let currentInput = input;
  const allOutputs: string[] = [];

  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i]!;
    const stepStart = Date.now();

    // Resolve agent
    const agent = agentRegistry.get(step.agent) || agentRegistry.getByName(step.agent);
    if (!agent) {
      const error = `Agent not found: ${step.agent}`;
      result.steps.push({
        agent: step.agent,
        input: currentInput,
        output: '',
        durationMs: Date.now() - stepStart,
        success: false,
        error,
      });

      if (definition.onFailure === 'stop') break;
      continue;
    }

    // Build input for this step
    let stepInput = currentInput;
    if (step.prefix) stepInput = step.prefix + stepInput;
    if (step.suffix) stepInput = stepInput + step.suffix;

    if (definition.chainMode === 'all-outputs' && allOutputs.length > 0) {
      stepInput = `[Previous step results]\n${allOutputs.join('\n---\n')}\n\n[Current task]\n${stepInput}`;
    }

    // Execute with retries
    let stepResult: Awaited<ReturnType<typeof sendMessage>> | null = null;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= definition.maxRetries; attempt++) {
      try {
        stepResult = await sendMessage({
          agentId: agent.id,
          sessionId,
          text: stepInput,
        });
        break;
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn({ pipeline: name, step: i, attempt, error: lastError }, 'Pipeline step failed');
        if (definition.onFailure === 'skip') break;
      }
    }

    const durationMs = Date.now() - stepStart;

    if (stepResult) {
      let output: string = stepResult.content ?? '';

      // Apply transform
      switch (step.transform) {
        case 'json-extract':
          try {
            const parsed = JSON.parse(output);
            output = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
          } catch { /* keep raw */ }
          break;
        case 'first-line':
          output = output.split('\n')[0] ?? output;
          break;
        case 'last-line':
          output = output.split('\n').filter(Boolean).pop() ?? output;
          break;
      }

      allOutputs.push(output);
      currentInput = output;

      result.steps.push({
        agent: agent.name,
        input: stepInput.slice(0, 500), // truncate for storage
        output: output.slice(0, 5000),
        durationMs,
        tokensUsed: stepResult.usage?.totalTokens,
        success: true,
      });
    } else {
      result.steps.push({
        agent: agent.name,
        input: stepInput.slice(0, 500),
        output: '',
        durationMs,
        success: false,
        error: lastError,
      });

      if (definition.onFailure === 'stop') break;
    }
  }

  result.finalOutput = currentInput;
  result.totalDurationMs = Date.now() - startTime;
  result.success = result.steps.every((s) => s.success);

  logger.info({
    pipeline: name,
    pipelineId: result.pipelineId,
    steps: result.steps.length,
    success: result.success,
    durationMs: result.totalDurationMs,
  }, 'Pipeline completed');

  return result;
}

/** List all registered pipelines */
export function listPipelines(): Array<{ name: string; description?: string; stepCount: number }> {
  return [...pipelines.values()].map((p) => ({
    name: p.name,
    description: p.description,
    stepCount: p.steps.length,
  }));
}

/** Get a pipeline definition */
export function getPipeline(name: string): PipelineDefinition | undefined {
  return pipelines.get(name);
}

/** Remove a pipeline */
export function removePipeline(name: string): boolean {
  return pipelines.delete(name);
}
