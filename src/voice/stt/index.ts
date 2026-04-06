// STT Service — adapter registry and orchestration

import type { SttAdapter, SttOptions, SttResult, AudioData } from '../types';
import { OpenAiWhisperAdapter } from './openai-whisper';
import { WebSpeechSttAdapter } from './web-speech';
import { convertAudio } from '../audio';
import { logger } from '../../shared/logger';

class SttService {
  private adapters = new Map<string, SttAdapter>();
  private defaultAdapter: string;

  constructor() {
    const whisper = new OpenAiWhisperAdapter();
    this.register(whisper);
    this.register(new WebSpeechSttAdapter());
    this.defaultAdapter = whisper.name;
  }

  register(adapter: SttAdapter): void {
    this.adapters.set(adapter.name, adapter);
    logger.debug({ adapter: adapter.name }, 'STT adapter registered');
  }

  getAdapter(name?: string): SttAdapter {
    const key = name || this.defaultAdapter;
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`STT adapter not found: ${key}`);
    return adapter;
  }

  async transcribe(
    audio: AudioData,
    options?: SttOptions,
  ): Promise<SttResult> {
    const adapter = this.getAdapter(options?.adapter);

    // Whisper expects specific formats — convert if needed
    const supportedFormats = ['mp3', 'ogg', 'wav', 'webm'];
    let audioInput = audio;
    if (!supportedFormats.includes(audio.format)) {
      audioInput = await convertAudio(audio, 'mp3');
    }

    return adapter.transcribe(audioInput, options);
  }
}

export const sttService = new SttService();
export { OpenAiWhisperAdapter } from './openai-whisper';
export { WebSpeechSttAdapter } from './web-speech';
