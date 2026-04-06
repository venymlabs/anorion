// Voice tools — speak (TTS), listen (STT), transcribe
// These tools allow agents to generate and understand speech

import type { ToolDefinition, ToolContext, ToolResult } from '../../shared/types';
import { ttsService } from '../../voice/tts';
import { sttService } from '../../voice/stt';
import { convertAudio, detectFormat } from '../../voice/audio';
import { logger } from '../../shared/logger';
import { writeFile, readFile, unlink, mkdtemp, rmdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ── speak: Text-to-speech tool ──

export const speakTool: ToolDefinition = {
  name: 'speak',
  description:
    'Convert text to speech audio. Returns a file path to the generated audio. ' +
    'Use this to send voice messages. Supports multiple voices and languages.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to convert to speech',
      },
      voice: {
        type: 'string',
        description: 'Voice to use (e.g. "en-US-AvaNeural" for Edge TTS, "alloy" for OpenAI)',
      },
      speed: {
        type: 'number',
        description: 'Speech speed from 0.5 (slow) to 2.0 (fast), default 1.0',
      },
      pitch: {
        type: 'number',
        description: 'Pitch adjustment in semitones (-20 to +20)',
      },
      format: {
        type: 'string',
        enum: ['mp3', 'ogg', 'wav', 'webm'],
        description: 'Output audio format (default: ogg for Telegram compatibility)',
      },
      language: {
        type: 'string',
        description: 'Language code (e.g. "en-US", "de-DE")',
      },
      provider: {
        type: 'string',
        enum: ['edge-tts', 'openai', 'elevenlabs'],
        description: 'TTS provider to use',
      },
    },
    required: ['text'],
  },
  category: 'voice',
  timeoutMs: 30_000,
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const text = String(params.text || '');
    if (!text.trim()) {
      return { content: 'Error: text is required', error: 'missing text' };
    }

    try {
      const result = await ttsService.synthesize(text, {
        voice: params.voice as string | undefined,
        speed: params.speed as number | undefined,
        pitch: params.pitch as number | undefined,
        format: (params.format as 'mp3' | 'ogg' | 'wav' | 'webm' | undefined) || 'ogg',
        language: params.language as string | undefined,
        adapter: params.provider as string | undefined,
      });

      // Write to temp file for channel pickup
      const workDir = await mkdtemp(join(tmpdir(), 'anorion-speak-'));
      const ext = result.audio.format === 'ogg' ? '.ogg' : result.audio.format === 'mp3' ? '.mp3' : '.wav';
      const filePath = join(workDir, `speech${ext}`);
      await writeFile(filePath, result.audio.buffer);

      return {
        content: `Audio generated: ${filePath} (${result.audio.buffer.length} bytes, ${result.audio.format}, provider: ${result.provider})`,
        metadata: {
          filePath,
          format: result.audio.format,
          bytes: result.audio.buffer.length,
          durationMs: result.audio.durationMs,
          provider: result.provider,
          charsProcessed: result.charsProcessed,
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, 'TTS speak tool failed');
      return { content: `TTS error: ${msg}`, error: msg };
    }
  },
};

// ── transcribe: Speech-to-text tool ──

export const transcribeTool: ToolDefinition = {
  name: 'transcribe',
  description:
    'Transcribe audio to text. Provide audio as a file path or URL. ' +
    'Returns the transcribed text with detected language.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Path to audio file to transcribe',
      },
      url: {
        type: 'string',
        description: 'URL to download audio from',
      },
      language: {
        type: 'string',
        description: 'Expected language code (e.g. "en", "de"). Auto-detected if not specified.',
      },
      hints: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hint phrases to improve recognition accuracy',
      },
      provider: {
        type: 'string',
        enum: ['openai-whisper', 'web-speech'],
        description: 'STT provider to use',
      },
    },
  },
  category: 'voice',
  timeoutMs: 60_000,
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    let audioBuffer: Buffer | null = null;
    let format: string | null = null;

    try {
      // Load audio from file path
      if (params.file) {
        const filePath = String(params.file);
        audioBuffer = await readFile(filePath);
        const ext = filePath.split('.').pop()?.toLowerCase();
        format = ext === 'ogg' ? 'ogg' : ext === 'mp3' ? 'mp3' : ext === 'wav' ? 'wav' : ext === 'webm' ? 'webm' : null;
      }

      // Download from URL
      if (!audioBuffer && params.url) {
        const url = String(params.url);
        const response = await fetch(url);
        if (!response.ok) {
          return { content: `Error downloading audio: ${response.status}`, error: 'download failed' };
        }
        const arrayBuffer = await response.arrayBuffer();
        audioBuffer = Buffer.from(arrayBuffer);
      }

      if (!audioBuffer) {
        return { content: 'Error: provide either "file" or "url" parameter', error: 'missing audio source' };
      }

      // Detect format if not known
      if (!format) {
        format = detectFormat(audioBuffer) || 'mp3';
      }

      const result = await sttService.transcribe(
        {
          buffer: audioBuffer,
          format: format as 'mp3' | 'ogg' | 'wav' | 'webm' | 'pcm',
          durationMs: undefined,
        },
        {
          language: params.language as string | undefined,
          hints: params.hints as string[] | undefined,
          adapter: params.provider as string | undefined,
        },
      );

      return {
        content: result.text || '(no speech detected)',
        metadata: {
          language: result.language,
          confidence: result.confidence,
          provider: result.provider,
          durationMs: result.durationMs,
          words: result.words?.length,
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      logger.error({ error: msg }, 'STT transcribe tool failed');
      return { content: `STT error: ${msg}`, error: msg };
    }
  },
};

// ── listen: Alias for transcribe with simpler interface ──

export const listenTool: ToolDefinition = {
  name: 'listen',
  description:
    'Listen to an audio message and return the transcribed text. ' +
    'A simpler version of the "transcribe" tool.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Path to audio file',
      },
      url: {
        type: 'string',
        description: 'URL to audio file',
      },
      language: {
        type: 'string',
        description: 'Language code hint (e.g. "en")',
      },
    },
  },
  category: 'voice',
  timeoutMs: 60_000,
  execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    // Delegate to transcribe
    return transcribeTool.execute(params, ctx);
  },
};
