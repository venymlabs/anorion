// TTS Service — adapter registry and orchestration

import type { TtsAdapter, TtsOptions, TtsResult, TtsVoice } from '../types';
import { EdgeTtsAdapter } from './edge-tts';
import { OpenAiTtsAdapter } from './openai-tts';
import { ElevenLabsTtsAdapter } from './elevenlabs';
import { convertAudio } from '../audio';
import { logger } from '../../shared/logger';
import type { AudioFormat } from '../types';

class TtsService {
  private adapters = new Map<string, TtsAdapter>();
  private defaultAdapter: string;

  constructor() {
    // Register built-in adapters
    const edge = new EdgeTtsAdapter();
    this.register(edge);
    this.register(new OpenAiTtsAdapter());
    this.register(new ElevenLabsTtsAdapter());
    this.defaultAdapter = edge.name;
  }

  register(adapter: TtsAdapter): void {
    this.adapters.set(adapter.name, adapter);
    logger.debug({ adapter: adapter.name }, 'TTS adapter registered');
  }

  getAdapter(name?: string): TtsAdapter {
    const key = name || this.defaultAdapter;
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`TTS adapter not found: ${key}`);
    return adapter;
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const adapter = this.getAdapter(options?.adapter);
    const result = await adapter.synthesize(text, options);

    // Convert to target format if needed
    if (options?.format && result.audio.format !== options.format) {
      result.audio = await convertAudio(result.audio, options.format);
    }

    return result;
  }

  async listVoices(adapterName?: string, language?: string): Promise<TtsVoice[]> {
    const adapter = this.getAdapter(adapterName);
    if (adapter.listVoices) {
      return adapter.listVoices(language);
    }
    return [];
  }
}

export const ttsService = new TtsService();
export { EdgeTtsAdapter } from './edge-tts';
export { OpenAiTtsAdapter } from './openai-tts';
export { ElevenLabsTtsAdapter } from './elevenlabs';
