// Multi-Provider LLM Support
// Unified provider registry supporting 15+ LLM providers
// Each provider has: id, name, models, defaultBaseURL, authMethod, capabilities

import { createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { logger } from '../shared/logger';

// ── Provider Definitions ──

export interface ProviderDef {
  id: string;
  name: string;
  icon: string;
  baseURL: string;
  envKey: string;
  authMethod: 'bearer' | 'api-key-header' | 'x-api-key';
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    vision: boolean;
    json: boolean;
  };
  popularModels: string[];
  defaultModel: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'zai',
    name: 'z.ai',
    icon: '⚡',
    baseURL: 'https://api.z.ai/api/paas/v4',
    envKey: 'ZAI_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-4.7'],
    defaultModel: 'glm-5.1',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🟢',
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'],
    defaultModel: 'gpt-4o',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🟣',
    baseURL: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    authMethod: 'x-api-key',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
    defaultModel: 'claude-sonnet-4-6',
  },
  {
    id: 'google',
    name: 'Google AI',
    icon: '🔵',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    authMethod: 'api-key-header',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    icon: '🌀',
    baseURL: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: false, json: true },
    popularModels: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest', 'mistral-small-latest'],
    defaultModel: 'mistral-large-latest',
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: '⚡',
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'together',
    name: 'Together AI',
    icon: '🤝',
    baseURL: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: false, json: true },
    popularModels: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct'],
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    icon: '🎆',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    envKey: 'FIREWORKS_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct'],
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🔍',
    baseURL: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: false, json: true },
    popularModels: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    icon: '𝕏',
    baseURL: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['grok-3', 'grok-3-mini', 'grok-2'],
    defaultModel: 'grok-3',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    icon: '💬',
    baseURL: 'https://api.cohere.ai/v1',
    envKey: 'COHERE_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: false, json: true },
    popularModels: ['command-r-plus', 'command-r'],
    defaultModel: 'command-r-plus',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    icon: '🔎',
    baseURL: 'https://api.perplexity.ai',
    envKey: 'PERPLEXITY_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: false, vision: false, json: true },
    popularModels: ['sonar-pro', 'sonar', 'sonar-reasoning'],
    defaultModel: 'sonar-pro',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '🌐',
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct'],
    defaultModel: 'anthropic/claude-sonnet-4',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    icon: '🦙',
    baseURL: 'http://localhost:11434/v1',
    envKey: 'OLLAMA_BASE_URL',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: true, json: true },
    popularModels: ['llama3.1:70b', 'qwen2.5:72b', 'codellama:70b', 'mistral:7b', 'gemma2:27b'],
    defaultModel: 'llama3.1:70b',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    icon: '🔧',
    baseURL: '',
    envKey: 'CUSTOM_API_KEY',
    authMethod: 'bearer',
    capabilities: { streaming: true, toolCalling: true, vision: false, json: true },
    popularModels: [],
    defaultModel: 'default',
  },
];

// ── Provider Instance Cache ──

const providerInstances = new Map<string, any>(); // provider instance cache

function getProviderInstance(providerId: string, apiKey?: string) {
  const cacheKey = `${providerId}:${apiKey || 'default'}`;
  if (providerInstances.has(cacheKey)) return providerInstances.get(cacheKey);

  const def = PROVIDERS.find((p) => p.id === providerId);
  if (!def) throw new Error(`Unknown provider: ${providerId}`);

  const key = apiKey || process.env[def.envKey] || '';
  const baseURL = providerId === 'ollama' 
    ? (process.env.OLLAMA_BASE_URL || def.baseURL)
    : def.baseURL;

  let instance: any;

  switch (providerId) {
    case 'zai':
    case 'openai':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'anthropic':
      instance = anthropic;
      break;
    case 'google':
      instance = createGoogleGenerativeAI({ apiKey: key });
      break;
    case 'mistral':
      instance = createMistral({ apiKey: key });
      break;
    case 'groq':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'together':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'fireworks':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'deepseek':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'xai':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'cohere':
      instance = createOpenAI({ baseURL: 'https://api.cohere.ai/v2', apiKey: key });
      break;
    case 'perplexity':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'openrouter':
      instance = createOpenAI({ baseURL, apiKey: key });
      break;
    case 'ollama':
      instance = createOpenAI({ baseURL, apiKey: 'ollama' }); // Ollama doesn't need a key
      break;
    case 'custom':
      instance = createOpenAI({ baseURL: process.env.CUSTOM_BASE_URL || '', apiKey: key });
      break;
    default:
      throw new Error(`No handler for provider: ${providerId}`);
  }

  providerInstances.set(cacheKey, instance);
  return instance;
}

// ── Model ID Resolution ──

export interface ResolvedModel {
  providerId: string;
  providerName: string;
  modelName: string;
  instance: any; // AI SDK model instance
  capabilities: ProviderDef['capabilities'];
}

/**
 * Resolve a model ID string to a provider instance + model name.
 * 
 * Formats:
 *   "provider/model"   → e.g. "openai/gpt-4o", "anthropic/claude-sonnet-4-6"
 *   "model"            → tries to auto-detect provider, falls back to default
 *   "provider"         → uses provider's default model
 */
export function resolveModel(modelId: string): ResolvedModel {
  const parts = modelId.split('/');
  
  let providerId: string;
  let modelName: string;

  if (parts.length >= 2) {
    // "provider/model" format
    providerId = parts[0]!;
    modelName = parts.slice(1).join('/');
  } else {
    // Try to match by model name across all providers
    const match = PROVIDERS.find((p) => p.popularModels.includes(modelId));
    if (match) {
      providerId = match.id;
      modelName = modelId;
    } else {
      // Fall back to default provider
      providerId = process.env.DEFAULT_LLM_PROVIDER || 'zai';
      modelName = modelId;
    }
  }

  const def = PROVIDERS.find((p) => p.id === providerId);
  if (!def) {
    throw new Error(`Unknown provider: ${providerId}. Available: ${PROVIDERS.map((p) => p.id).join(', ')}`);
  }

  const instance = getProviderInstance(providerId);
  const model = instance(modelName);

  return {
    providerId,
    providerName: def.name,
    modelName,
    instance: model,
    capabilities: def.capabilities,
  };
}

/** List all configured providers (have API keys set) */
export function listConfiguredProviders(): Array<{
  id: string;
  name: string;
  icon: string;
  configured: boolean;
  models: string[];
}> {
  return PROVIDERS.map((p) => {
    const hasKey = !!process.env[p.envKey];
    return {
      id: p.id,
      name: p.name,
      icon: p.icon,
      configured: hasKey,
      models: p.popularModels,
    };
  });
}

/** Check which providers are available */
export function getAvailableProviders(): ProviderDef[] {
  return PROVIDERS.filter((p) => !!process.env[p.envKey]);
}

/** Get provider definition */
export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Test a provider connection */
export async function testProvider(providerId: string, model?: string): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const def = PROVIDERS.find((p) => p.id === providerId);
  if (!def) return { ok: false, latencyMs: 0, error: `Unknown provider: ${providerId}` };
  if (!process.env[def.envKey]) return { ok: false, latencyMs: 0, error: `No API key set: ${def.envKey}` };

  try {
    const resolved = resolveModel(`${providerId}/${model || def.defaultModel}`);
    const start = Date.now();

    const { generateText } = await import('ai');
    await generateText({
      model: resolved.instance,
      prompt: 'Say "ok" and nothing else.',
      maxOutputTokens: 5,
    });

    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: 0, error: (err as Error).message };
  }
}
