// OpenAI TTS adapter — uses OpenAI's Text-to-Speech API
// Supports tts-1 and tts-1-hd models with various voices

import type { TtsAdapter, TtsOptions, TtsResult, TtsVoice } from '../types';
import { logger } from '../../shared/logger';
import { segmentText } from '../audio';

/** Map our AudioFormat to OpenAI TTS response_format values */
function mapToOpenAiFormat(format?: string): string {
  switch (format) {
    case 'ogg': return 'opus';
    case 'wav': return 'wav';
    case 'mp3': return 'mp3';
    case 'webm': return 'opus'; // OpenAI doesn't support webm, use opus as closest
    default: return 'mp3';
  }
}

/** Map OpenAI response_format back to our AudioFormat */
function mapFromOpenAiFormat(openaiFormat: string): 'mp3' | 'ogg' | 'wav' | 'webm' {
  switch (openaiFormat) {
    case 'opus': return 'ogg';
    case 'wav': return 'wav';
    case 'aac': return 'mp3';
    case 'flac': return 'wav';
    case 'pcm': return 'wav';
    default: return 'mp3';
  }
}

const OPENAI_TTS_VOICES: TtsVoice[] = [
  { id: 'alloy', name: 'Alloy', language: 'en', gender: 'neutral' },
  { id: 'ash', name: 'Ash', language: 'en', gender: 'male' },
  { id: 'ballad', name: 'Ballad', language: 'en', gender: 'male' },
  { id: 'coral', name: 'Coral', language: 'en', gender: 'female' },
  { id: 'echo', name: 'Echo', language: 'en', gender: 'male' },
  { id: 'fable', name: 'Fable', language: 'en', gender: 'neutral' },
  { id: 'nova', name: 'Nova', language: 'en', gender: 'female' },
  { id: 'onyx', name: 'Onyx', language: 'en', gender: 'male' },
  { id: 'sage', name: 'Sage', language: 'en', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', language: 'en', gender: 'female' },
];

export class OpenAiTtsAdapter implements TtsAdapter {
  name = 'openai';
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.apiKey = opts?.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = opts?.baseUrl || 'https://api.openai.com/v1';
    this.model = opts?.model || 'tts-1';
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    if (!this.apiKey) throw new Error('OpenAI API key is required for OpenAI TTS');

    const openaiFormat = mapToOpenAiFormat(options?.format);
    const actualFormat = mapFromOpenAiFormat(openaiFormat);
    const segments = segmentText(text, options?.chunkMaxLength ?? 4096);
    const chunks: Buffer[] = [];

    for (const segment of segments) {
      const response = await fetch(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: segment,
          voice: options?.voice || 'alloy',
          speed: options?.speed || 1.0,
          response_format: openaiFormat,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI TTS error: ${response.status} ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      chunks.push(Buffer.from(arrayBuffer));
    }

    return {
      audio: {
        buffer: Buffer.concat(chunks),
        format: actualFormat,
      },
      charsProcessed: text.length,
      provider: this.name,
    };
  }

  async listVoices(): Promise<TtsVoice[]> {
    return OPENAI_TTS_VOICES;
  }
}
