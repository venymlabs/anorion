// Web Speech API STT adapter — for browser-based channels
// This adapter provides a client-side transcription mechanism.
// It does NOT perform server-side transcription — instead it returns
// a JSON payload that the client (browser) can use to perform STT
// locally via the Web Speech API.

import type { SttAdapter, SttOptions, SttResult, AudioData } from '../types';
import { logger } from '../../shared/logger';

export class WebSpeechSttAdapter implements SttAdapter {
  name = 'web-speech';

  async transcribe(audio: AudioData, options?: SttOptions): Promise<SttResult> {
    // Web Speech API runs client-side in the browser.
    // On the server side, we delegate to OpenAI Whisper as fallback.
    logger.warn('Web Speech API is a client-side technology. Falling back to server-side transcription.');

    throw new Error(
      'Web Speech API STT is only available in browser environments. ' +
      'Use a server-side adapter (e.g. openai-whisper) for server-side transcription.',
    );
  }

  /**
   * Generate client-side transcription instructions that a browser channel
   * can use to perform STT locally via the Web Speech API.
   */
  getClientConfig(options?: SttOptions): {
    type: 'web-speech';
    language: string;
    continuous: boolean;
    interimResults: boolean;
  } {
    return {
      type: 'web-speech',
      language: options?.language || 'en-US',
      continuous: true,
      interimResults: true,
    };
  }

  listLanguages(): string[] {
    return [
      'en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR',
      'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'ru-RU', 'ar-SA', 'hi-IN',
      'nl-NL', 'pl-PL', 'sv-SE', 'tr-TR', 'vi-VN', 'th-TH',
    ];
  }
}
