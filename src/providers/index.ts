// Providers — auto-register all built-in adapters

export { type ProviderAdapter, type NormalizedRequest, type NormalizedResponse, type NormalizedMessage, type StreamChunkDelta, type NormalizedTool, type NormalizedToolCall, type NormalizedUsage } from './types';
export { ProviderRegistry, providerRegistry } from './registry';
export { AiSdkAdapter } from './adapters/ai-sdk';

import { providerRegistry } from './registry';
import { AiSdkAdapter } from './adapters/ai-sdk';
import { PROVIDERS } from '../llm/providers';

// Auto-register one adapter per provider definition
for (const def of PROVIDERS) {
  providerRegistry.register(new AiSdkAdapter(def.id, def.name, def));
}
