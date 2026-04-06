// Edge TTS adapter — free Microsoft TTS via WebSocket (no API key required)
// Uses the same WebSocket endpoint as Microsoft Edge's read-aloud feature
// Falls back to the `edge-tts` Python CLI if WebSocket fails

import type { TtsAdapter, TtsOptions, TtsResult, TtsVoice } from '../types';
import { logger } from '../../shared/logger';
import { segmentText } from '../audio';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'fs/promises';

const EDGE_TTS_WS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// Well-known Edge TTS voices
const DEFAULT_VOICES: TtsVoice[] = [
  { id: 'en-US-AvaNeural', name: 'Ava', language: 'en-US', gender: 'female' },
  { id: 'en-US-AndrewNeural', name: 'Andrew', language: 'en-US', gender: 'male' },
  { id: 'en-US-EmmaNeural', name: 'Emma', language: 'en-US', gender: 'female' },
  { id: 'en-US-BrianNeural', name: 'Brian', language: 'en-US', gender: 'male' },
  { id: 'en-US-JennyNeural', name: 'Jenny', language: 'en-US', gender: 'female' },
  { id: 'en-US-GuyNeural', name: 'Guy', language: 'en-US', gender: 'male' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', language: 'en-GB', gender: 'female' },
  { id: 'en-GB-RyanNeural', name: 'Ryan', language: 'en-GB', gender: 'male' },
  { id: 'de-DE-KatjaNeural', name: 'Katja', language: 'de-DE', gender: 'female' },
  { id: 'de-DE-ConradNeural', name: 'Conrad', language: 'de-DE', gender: 'male' },
  { id: 'fr-FR-DeniseNeural', name: 'Denise', language: 'fr-FR', gender: 'female' },
  { id: 'fr-FR-HenriNeural', name: 'Henri', language: 'fr-FR', gender: 'male' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', language: 'es-ES', gender: 'female' },
  { id: 'es-ES-AlvaroNeural', name: 'Alvaro', language: 'es-ES', gender: 'male' },
  { id: 'ja-JP-NanamiNeural', name: 'Nanami', language: 'ja-JP', gender: 'female' },
  { id: 'ja-JP-KeitaNeural', name: 'Keita', language: 'ja-JP', gender: 'male' },
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', language: 'zh-CN', gender: 'female' },
  { id: 'zh-CN-YunxiNeural', name: 'Yunxi', language: 'zh-CN', gender: 'male' },
  { id: 'pt-BR-FranciscaNeural', name: 'Francisca', language: 'pt-BR', gender: 'female' },
  { id: 'pt-BR-AntonioNeural', name: 'Antonio', language: 'pt-BR', gender: 'male' },
];

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Extract the language code from a voice name like "en-US-AvaNeural" → "en-US" */
function languageFromVoice(voice: string): string {
  const match = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  return match?.[1] ?? 'en-US';
}

/** Edge TTS WebSocket message parser — extracts audio from the binary stream */
function parseWsMessage(data: string | Uint8Array): { type: 'text' | 'audio'; text?: string; audio?: Buffer } {
  if (typeof data === 'string') {
    return { type: 'text', text: data };
  }

  // Binary frame: header + audio
  // The header is separated from audio by two CRLF pairs (\r\n\r\n)
  const buf = Buffer.from(data);
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    return { type: 'audio', audio: buf };
  }

  const header = buf.subarray(0, headerEnd).toString('utf-8');
  const audioData = buf.subarray(headerEnd + 4);

  // Check if this is a path response with audio content
  if (header.includes('Path:audio')) {
    return { type: 'audio', audio: Buffer.from(audioData) };
  }

  // Some binary frames are just turn headers with no audio
  if (audioData.length === 0) {
    return { type: 'text', text: header };
  }

  return { type: 'audio', audio: Buffer.from(audioData) };
}

/**
 * Synthesize a single segment via Edge TTS WebSocket protocol.
 */
async function synthesizeViaWebSocket(
  ssml: string,
  voice: string,
  requestId: string,
  outputFormat: string,
): Promise<Buffer> {
  const url = `${EDGE_TTS_WS_URL}?ConnectionId=${requestId}&TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

  return new Promise<Buffer>((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    let settled = false;

    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error('Edge TTS WebSocket timeout'));
      }
    }, 30_000);

    ws.addEventListener('open', () => {
      const dateStr = new Date().toString();

      // 1. Configuration message
      const configMsg = [
        `X-RequestId:${requestId}`,
        'Content-Type:application/json; charset=utf-8',
        `X-Timestamp:${dateStr}Z`,
        'Path:speech.config',
        '',
        '',
        JSON.stringify({
          context: {
            synthesis: {
              audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat },
            },
          },
        }),
      ].join('\r\n');
      ws.send(configMsg);

      // 2. SSML message
      const ssmlMsg = [
        `X-RequestId:${requestId}`,
        'Content-Type:application/ssml+xml',
        `X-Timestamp:${dateStr}Z`,
        'Path:ssml',
        '',
        '',
        ssml,
      ].join('\r\n');
      ws.send(ssmlMsg);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const parsed = parseWsMessage(event.data as string | Uint8Array);

      if (parsed.type === 'audio' && parsed.audio && parsed.audio.length > 0) {
        audioChunks.push(parsed.audio);
      }

      if (parsed.type === 'text' && parsed.text) {
        // Check for turn end
        if (parsed.text.includes('Path:turn.end')) {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            ws.close();
            if (audioChunks.length > 0) {
              resolve(Buffer.concat(audioChunks));
            } else {
              reject(new Error('Edge TTS WebSocket: turn ended with no audio'));
            }
          }
        }
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error('Edge TTS WebSocket error'));
      }
    });

    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        if (audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(new Error('Edge TTS WebSocket closed with no audio'));
        }
      }
    });
  });
}

export class EdgeTtsAdapter implements TtsAdapter {
  name = 'edge-tts';

  async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const voice = options?.voice || 'en-US-AvaNeural';
    const rate = options?.speed ? (options.speed - 1) * 100 : 0;
    const pitch = options?.pitch || 0;
    const segments = segmentText(text, options?.chunkMaxLength ?? 500);

    const rateStr = `${rate >= 0 ? '+' : ''}${Math.round(rate)}%`;
    const pitchStr = `${pitch >= 0 ? '+' : ''}${Math.round(pitch)}Hz`;

    // Use the voice's language for the SSML xml:lang attribute
    const lang = options?.language ?? languageFromVoice(voice);

    const audioChunks: Buffer[] = [];

    for (const segment of segments) {
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>
  <voice name='${voice}'>
    <prosody pitch='${pitchStr}' rate='${rateStr}'>
      ${escapeXml(segment)}
    </prosody>
  </voice>
</speak>`;

      const audio = await this.requestSynthesis(ssml, voice);
      if (audio) audioChunks.push(audio);
    }

    if (audioChunks.length === 0) {
      throw new Error('Edge TTS produced no audio output');
    }

    const buffer = Buffer.concat(audioChunks);

    return {
      audio: {
        buffer,
        format: 'mp3',
        durationMs: undefined,
      },
      charsProcessed: text.length,
      provider: this.name,
    };
  }

  private async requestSynthesis(ssml: string, voice: string): Promise<Buffer | null> {
    const requestId = crypto.randomUUID().replace(/-/g, '');

    // Try WebSocket first
    try {
      return await synthesizeViaWebSocket(ssml, voice, requestId, 'audio-24khz-48kbitrate-mono-mp3');
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'Edge TTS WebSocket failed, trying CLI fallback');
    }

    // Fallback: use edge-tts Python CLI
    return this.synthesizeWithCli(ssml);
  }

  /** Fallback: use edge-tts Python CLI if installed */
  private async synthesizeWithCli(ssml: string): Promise<Buffer | null> {
    const workDir = await mkdtemp(join(tmpdir(), 'anorion-edge-tts-'));
    const outputPath = join(workDir, 'output.mp3');

    try {
      // Extract text from SSML
      const textMatch = ssml.match(/<prosody[^>]*>([\s\S]*?)<\/prosody>/);
      const text = textMatch?.[1]
        ?.replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'") ?? '';

      if (!text) {
        logger.debug('Edge TTS CLI: empty text extracted from SSML');
        return null;
      }

      const voiceMatch = ssml.match(/<voice name='([^']+)'/);
      const voice = voiceMatch?.[1] ?? 'en-US-AvaNeural';

      // Extract rate and pitch from SSML
      const rateMatch = ssml.match(/rate='([^']+)'/);
      const rate = rateMatch?.[1] ?? '+0%';

      const pitchMatch = ssml.match(/pitch='([^']+)'/);
      const pitch = pitchMatch?.[1] ?? '+0Hz';

      const args = [
        'edge-tts',
        '--voice', voice,
        '--rate', rate,
        '--pitch', pitch,
        '--text', text,
        '--write-media', outputPath,
      ];

      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        logger.debug({ exitCode, stderr: stderr.slice(0, 500) }, 'edge-tts CLI failed');
        return null;
      }

      const data = await readFile(outputPath);
      return Buffer.from(data);
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'edge-tts CLI error');
      return null;
    } finally {
      try { await unlink(outputPath); } catch { /* ignore */ }
      try { await rmdir(workDir); } catch { /* ignore */ }
    }
  }

  async listVoices(language?: string): Promise<TtsVoice[]> {
    if (language) {
      const prefix = language.split('-')[0];
      if (!prefix) return DEFAULT_VOICES;
      return DEFAULT_VOICES.filter((v) => v.language.startsWith(prefix));
    }
    return DEFAULT_VOICES;
  }
}
