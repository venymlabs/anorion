// OpenAI Whisper STT adapter — uses OpenAI's Speech-to-Text API
// Supports Whisper-1 model with multiple languages

import type { SttAdapter, SttOptions, SttResult, AudioData } from '../types';
import { logger } from '../../shared/logger';

const FORMAT_EXTENSIONS: Record<string, string> = {
  mp3: '.mp3',
  ogg: '.ogg',
  wav: '.wav',
  webm: '.webm',
  pcm: '.pcm',
};

/** Map AudioFormat to a MIME type for the Whisper API file upload */
function mimeTypeForFormat(format: string): string {
  switch (format) {
    case 'mp3': return 'audio/mpeg';
    case 'ogg': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    case 'webm': return 'audio/webm';
    default: return 'application/octet-stream';
  }
}

export class OpenAiWhisperAdapter implements SttAdapter {
  name = 'openai-whisper';
  private apiKey: string;
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = opts?.baseUrl || 'https://api.openai.com/v1';
  }

  async transcribe(audio: AudioData, options?: SttOptions): Promise<SttResult> {
    if (!this.apiKey) throw new Error('OpenAI API key is required for Whisper STT');

    const ext = FORMAT_EXTENSIONS[audio.format] || '.mp3';
    const filename = `audio${ext}`;
    const mimeType = mimeTypeForFormat(audio.format);

    // Use Uint8Array (which is a valid BlobPart) instead of Buffer
    const fileBlob = new File([new Uint8Array(audio.buffer)], filename, { type: mimeType });

    const formData = new FormData();
    formData.append('file', fileBlob, filename);
    formData.append('model', 'whisper-1');

    if (options?.language) {
      formData.append('language', options.language);
    }

    if (options?.hints && options.hints.length > 0) {
      formData.append('prompt', options.hints.join(' '));
    }

    // Request word-level timestamps if needed — requires verbose_json format
    if (options?.wordTimestamps) {
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');
    }

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper STT error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      text: string;
      language?: string;
      duration?: number;
      segments?: Array<{
        text: string;
        start: number;
        end: number;
        avg_logprob: number;
        words?: Array<{ word: string; start: number; end: number; probability: number }>;
      }>;
      words?: Array<{ word: string; start: number; end: number; probability: number }>;
    };

    // Build word-level details if available
    // verbose_json returns words at top level and/or per-segment
    let words: SttResult['words'];

    if (options?.wordTimestamps) {
      // Prefer top-level words array
      const rawWords = data.words ?? data.segments?.flatMap((s) => s.words ?? []);
      if (rawWords && rawWords.length > 0) {
        words = rawWords.map((w) => ({
          word: w.word,
          startMs: Math.round(w.start * 1000),
          endMs: Math.round(w.end * 1000),
          confidence: w.probability,
        }));
      }
    }

    // Compute confidence from segment log probabilities
    let confidence = 0.9;
    if (data.segments && data.segments.length > 0) {
      const avgLogprob = data.segments.reduce((sum, s) => sum + s.avg_logprob, 0) / data.segments.length;
      confidence = Math.exp(avgLogprob);
    }

    return {
      text: data.text?.trim() || '',
      language: data.language || options?.language || 'en',
      confidence,
      words,
      provider: this.name,
      durationMs: data.duration ? Math.round(data.duration * 1000) : audio.durationMs,
    };
  }

  listLanguages(): string[] {
    // Whisper supports many languages — common ones listed
    return [
      'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr',
      'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
      'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
      'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
      'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk',
      'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
      'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc',
      'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
      'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl',
      'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
    ];
  }
}
