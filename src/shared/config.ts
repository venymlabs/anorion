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
  secret: z.string().default('anorion-bridge-dev'),
  port: z.number().default(4260),
  peers: z.array(z.object({
    url: z.string(),
    secret: z.string().optional(),
  })).default([]),
});

const memorySchema = z.object({
  provider: z.enum(['file', 'sqlite']).default('file'),
  directory: z.string().default('./data/memory'),
});

const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  allowedUsers: z.array(z.string()).default([]),
  defaultAgent: z.string().default('example'),
});

const webhookChannelSchema = z.object({
  enabled: z.boolean().default(false),
  inboundSecret: z.string().default(''),
  outboundUrls: z.array(z.string()).default([]),
  allowedIps: z.array(z.string()).default([]),
});

const discordChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(''),
  allowedGuilds: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  defaultAgent: z.string().default('example'),
  maxMessageLength: z.number().default(2000),
});

const whatsappChannelSchema = z.object({
  enabled: z.boolean().default(false),
  authDir: z.string().default('./data/whatsapp-auth'),
  allowedNumbers: z.array(z.string()).default([]),
  allowedGroups: z.array(z.string()).default([]),
  defaultAgent: z.string().default('example'),
  handleGroups: z.boolean().default(true),
  groupPrefix: z.string().default('!'),
});

const signalChannelSchema = z.object({
  enabled: z.boolean().default(false),
  apiUrl: z.string().default('http://localhost:8080'),
  phoneNumber: z.string().default(''),
  allowedNumbers: z.array(z.string()).default([]),
  allowedGroups: z.array(z.string()).default([]),
  defaultAgent: z.string().default('example'),
  pollIntervalMs: z.number().default(3000),
  handleGroups: z.boolean().default(true),
  groupPrefix: z.string().default('!'),
  attachmentDir: z.string().default('./data/signal-attachments'),
});

const streamingSchema = z.object({
  enabled: z.boolean().default(true),
  minDeltaChars: z.number().default(15),
  updateIntervalMs: z.number().default(800),
  maxBufferMs: z.number().default(2000),
  initialText: z.string().default('…'),
  showTyping: z.boolean().default(true),
});

const channelsSchema = z.object({
  streaming: streamingSchema.default({} as any),
  telegram: telegramChannelSchema.default({} as any),
  webhook: webhookChannelSchema.default({} as any),
  discord: discordChannelSchema.default({} as any),
  whatsapp: whatsappChannelSchema.default({} as any),
  signal: signalChannelSchema.default({} as any),
});

const skillsSchema = z.object({
  dir: z.string().default('./skills'),
  watch: z.boolean().default(false),
});

const auditSchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default('./data/audit.db'),
});

const tokenBudgetSchema = z.object({
  enabled: z.boolean().default(false),
  sessionLimit: z.number().default(500_000),
  dailyLimit: z.number().default(2_000_000),
  globalDailyLimit: z.number().default(10_000_000),
  mode: z.enum(['track', 'enforce']).default('enforce'),
});

const pipelinesSchema = z.object({
  dir: z.string().optional(),
});

// ── MCP (Model Context Protocol) ──

const mcpTransportSchema = z.union([
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);

const mcpServerSchema = z.object({
  name: z.string(),
  transport: mcpTransportSchema,
  timeoutMs: z.number().default(10_000),
  autoReconnect: z.boolean().default(true),
  maxReconnectAttempts: z.number().default(5),
  toolTimeoutMs: z.number().default(30_000),
  enabled: z.boolean().default(true),
});

const mcpSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
});

// ── Voice (TTS/STT) ──

const voiceSchema = z.object({
  enabled: z.boolean().default(false),
  /** Default TTS provider */
  ttsProvider: z.enum(['edge-tts', 'openai', 'elevenlabs']).default('edge-tts'),
  /** Default STT provider */
  sttProvider: z.enum(['openai-whisper', 'web-speech']).default('openai-whisper'),
  /** Default voice for TTS (provider-specific) */
  defaultVoice: z.string().default('en-US-AvaNeural'),
  /** Default language */
  defaultLanguage: z.string().default('en-US'),
  /** Default speech speed (0.5-2.0) */
  defaultSpeed: z.number().default(1.0),
  /** Default pitch adjustment */
  defaultPitch: z.number().default(0),
  /** Output audio format for channels */
  outputFormat: z.enum(['mp3', 'ogg', 'wav', 'webm']).default('ogg'),
  /** OpenAI API key override for TTS/STT (defaults to OPENAI_API_KEY env) */
  openaiApiKey: z.string().default(''),
  /** OpenAI base URL override */
  openaiBaseUrl: z.string().default(''),
  /** ElevenLabs API key */
  elevenlabsApiKey: z.string().default(''),
  /** Silence threshold for ending voice conversations (ms) */
  conversationSilenceMs: z.number().default(300_000),
});

const configSchema = z.object({
  voice: voiceSchema.default({} as any),
  gateway: gatewaySchema.default({} as any),
  agents: agentsSchema.default({} as any),
  scheduler: schedulerSchema.default({} as any),
  bridge: bridgeSchema.default({} as any),
  memory: memorySchema.default({} as any),
  channels: channelsSchema.default({} as any),
  skills: skillsSchema.default({} as any),
  audit: auditSchema.default({} as any),
  tokenBudget: tokenBudgetSchema.default({} as any),
  pipelines: pipelinesSchema.default({} as any),
  mcp: mcpSchema.default({} as any),
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
