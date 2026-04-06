// ElevenLabs TTS adapter — uses ElevenLabs Text-to-Speech API
// High-quality neural voices with low latency

import type { TtsAdapter, TtsOptions, TtsResult, TtsVoice } from '../types';
import { logger } from '../../shared/logger';
import { segmentText } from '../audio';

export class ElevenLabsTtsAdapter implements TtsAdapter {
  name = 'elevenlabs';
  private apiKey: string;
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey || process.env.ELEVENLABS_API_KEY || '';
    this.baseUrl = opts?.baseUrl || 'https://api.elevenlabs.io/v1';
  }

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    if (!this.apiKey) throw new Error('ElevenLabs API key is required');

    const voiceId = options?.voice || '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)
    const segments = segmentText(text, options?.chunkMaxLength ?? 5000);
    const chunks: Buffer[] = [];

    // Map output format to ElevenLabs output_format parameter
    const outputFormat = options?.format || 'mp3';
    const elevenlabsFormat = outputFormat === 'ogg' ? 'mp3_44100_128' : outputFormat === 'wav' ? 'pcm_44100' : 'mp3_44100_128';
    const acceptHeader = outputFormat === 'wav' ? 'audio/wav' : outputFormat === 'ogg' ? 'audio/ogg' : 'audio/mpeg';

    for (const segment of segments) {
      const response = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': acceptHeader,
        },
        body: JSON.stringify({
          text: segment,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: options?.speed || 1.0,
            ...(options?.pitch ? { use_speaker_boost: true } : {}),
          },
          output_format: elevenlabsFormat,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs TTS error: ${response.status} ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      chunks.push(Buffer.from(arrayBuffer));
    }

    return {
      audio: {
        buffer: Buffer.concat(chunks),
        format: options?.format || 'mp3',
      },
      charsProcessed: text.length,
      provider: this.name,
    };
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!this.apiKey) return [];

    try {
      const response = await fetch(`${this.baseUrl}/voices`, {
        headers: { 'xi-api-key': this.apiKey },
      });

      if (!response.ok) return [];

      const data = await response.json() as { voices: Array<{ voice_id: string; name: string; labels?: Record<string, string>; language?: string }> };
      return data.voices.map((v) => ({
        id: v.voice_id,
        name: v.name,
        language: v.labels?.language || 'en',
        gender: (v.labels?.gender as 'male' | 'female' | 'neutral') || undefined,
      }));
    } catch {
      return [];
    }
  }
}
