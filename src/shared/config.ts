import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const apiKeySchema = z.object({
  name: z.string(),
  key: z.string(),
  scopes: z.array(z.string()).default(['*']),
});

const gatewaySchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(4250),
  apiKeys: z.array(apiKeySchema).default([]),
  database: z.string().default('./data/anorion.db'),
});

const agentsSchema = z.object({
  dir: z.string().default('./agents'),
  defaultModel: z.string().default('openai/gpt-4o'),
  defaultTimeoutMs: z.number().default(120000),
  maxSubagents: z.number().default(5),
  idleTimeoutMs: z.number().default(1800000),
});

const schedulerSchema = z.object({
  enabled: z.boolean().default(true),
});

const bridgeSchema = z.object({
  enabled: z.boolean().default(false),
  peers: z.array(z.record(z.unknown())).default([]),
});

const memorySchema = z.object({
  provider: z.enum(['file', 'sqlite']).default('file'),
  directory: z.string().default('./data/memory'),
});

const configSchema = z.object({
  gateway: gatewaySchema.default({}),
  agents: agentsSchema.default({}),
  scheduler: schedulerSchema.default({}),
  bridge: bridgeSchema.default({}),
  memory: memorySchema.default({}),
});

export type AnorionConfig = z.infer<typeof configSchema>;

function substituteEnv(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, varName, defaultVal) => process.env[varName] || defaultVal || '');
  }
  if (Array.isArray(obj)) return obj.map(substituteEnv);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = substituteEnv(v);
    }
    return out;
  }
  return obj;
}

export function loadConfig(configPath?: string): AnorionConfig {
  const path = configPath || resolve(process.cwd(), 'anorion.yaml');

  if (!existsSync(path)) {
    // Return defaults
    return configSchema.parse({});
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  const substituted = substituteEnv(parsed) as Record<string, unknown>;
  return configSchema.parse(substituted);
}
