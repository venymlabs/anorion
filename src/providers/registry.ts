// Provider Registry — resolves "provider/model" strings to adapters

import type { ProviderAdapter, NormalizedRequest, NormalizedResponse, StreamChunkDelta } from './types';
import { PROVIDERS, resolveModel } from '../llm/providers';
import { logger } from '../shared/logger';

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
    logger.debug({ provider: adapter.id }, 'Provider adapter registered');
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /**
   * Resolve a model string to an adapter + model name.
   * Formats:
   *   "provider/model"   → specific adapter, specific model
   *   "model"            → auto-detect provider or use default
   *   "provider"         → adapter's default model
   */
  resolve(modelStr: string): { adapter: ProviderAdapter; modelName: string } {
    const parts = modelStr.split('/');
    let providerId: string;
    let modelName: string;

    if (parts.length >= 2) {
      providerId = parts[0]!;
      modelName = parts.slice(1).join('/');
    } else {
      // Try to find provider that has this model
      const match = PROVIDERS.find((p) => p.popularModels.includes(modelStr));
      if (match) {
        providerId = match.id;
        modelName = modelStr;
      } else {
        providerId = process.env.DEFAULT_LLM_PROVIDER || 'zai';
        modelName = modelStr;
      }
    }

    const adapter = this.adapters.get(providerId);
    if (adapter) {
      // If only provider was given, use default model
      if (parts.length === 1 && PROVIDERS.find((p) => p.id === modelStr)) {
        modelName = PROVIDERS.find((p) => p.id === modelStr)!.defaultModel;
      }
      return { adapter, modelName };
    }

    throw new Error(`Unknown provider: ${providerId}. Available: ${[...this.adapters.keys()].join(', ')}`);
  }

  /** Check if a provider is available (has API key) */
  isAvailable(providerId: string): boolean {
    const adapter = this.adapters.get(providerId);
    return adapter ? adapter.validateConfig() : false;
  }

  /** List all registered adapters */
  listAdapters(): Array<{ id: string; name: string; configured: boolean; models: string[] }> {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      name: a.name,
      configured: a.validateConfig(),
      models: a.listModels(),
    }));
  }

  /** Convenience: non-streaming completion via registry */
  async chatCompletion(req: NormalizedRequest): Promise<NormalizedResponse> {
    const { adapter, modelName } = this.resolve(req.model);
    return adapter.chatCompletion({ ...req, model: modelName });
  }

  /** Convenience: streaming completion via registry */
  async *chatCompletionStream(req: NormalizedRequest): AsyncIterable<StreamChunkDelta> {
    const { adapter, modelName } = this.resolve(req.model);
    yield* adapter.chatCompletionStream({ ...req, model: modelName });
  }
}

/** Singleton registry */
export const providerRegistry = new ProviderRegistry();
