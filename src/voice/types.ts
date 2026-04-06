// Voice types for TTS (Text-to-Speech) and STT (Speech-to-Text) integration

// ── Audio format types ──

export type AudioFormat = 'mp3' | 'ogg' | 'wav' | 'webm' | 'pcm';

export interface AudioData {
  buffer: Buffer;
  format: AudioFormat;
  sampleRate?: number;
  channels?: number;
  durationMs?: number;
}

// ── TTS types ──

export interface TtsOptions {
  /** Voice identifier (provider-specific) */
  voice?: string;
  /** Speech rate (0.5 - 2.0, default 1.0) */
  speed?: number;
  /** Pitch adjustment (-20 to +20 semitones) */
  pitch?: number;
  /** Output audio format */
  format?: AudioFormat;
  /** Language code (e.g. 'en-US') */
  language?: string;
  /** Maximum characters per chunk for long text segmentation */
  chunkMaxLength?: number;
  /** TTS adapter name override (e.g. 'edge-tts' | 'openai' | 'elevenlabs') */
  adapter?: string;
}

export interface TtsResult {
  audio: AudioData;
  /** Characters processed */
  charsProcessed: number;
  /** Provider that generated the audio */
  provider: string;
}

export interface TtsAdapter {
  name: string;
  /** Synthesize text to audio */
  synthesize(text: string, options?: TtsOptions): Promise<TtsResult>;
  /** Stream synthesis — yields audio chunks as they're generated */
  synthesizeStream?(text: string, options?: TtsOptions): AsyncIterable<AudioData>;
  /** List available voices */
  listVoices?(language?: string): Promise<TtsVoice[]>;
}

export interface TtsVoice {
  id: string;
  name: string;
  language: string;
  gender?: 'male' | 'female' | 'neutral';
  previewUrl?: string;
}

// ── STT types ──

export interface SttOptions {
  /** Expected language code (e.g. 'en-US') */
  language?: string;
  /** Auto-detect language */
  autoDetectLanguage?: boolean;
  /** Hint phrases to improve recognition accuracy */
  hints?: string[];
  /** Enable word-level timestamps */
  wordTimestamps?: boolean;
  /** STT adapter name override (de.g. 'openai-whisper') or 'web-speech') */
  adapter?: string;
}

export interface SttResult {
  /** Transcribed text */
  text: string;
  /** Detected or specified language */
  language: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Word-level details if requested */
  words?: SttWord[];
  /** Provider that performed the transcription */
  provider: string;
  /** Duration of the audio in ms */
  durationMs?: number;
}

export interface SttWord {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface SttAdapter {
  name: string;
  /** Transcribe audio to text */
  transcribe(audio: AudioData, options?: SttOptions): Promise<SttResult>;
  /** Stream transcription — yields partial results */
  transcribeStream?(audio: AsyncIterable<AudioData>, options?: SttOptions): AsyncIterable<SttResult>;
  /** List supported languages */
  listLanguages?(): string[];
}

// ── Voice config (per-agent) ──

export interface VoiceConfig {
  /** Enable voice for this agent */
  enabled: boolean;
  /** TTS provider */
  ttsProvider?: 'edge-tts' | 'openai' | 'elevenlabs';
  /** STT provider */
  sttProvider?: 'openai-whisper' | 'web-speech';
  /** Default voice for TTS */
  voice?: string;
  /** Default language */
  language?: string;
  /** TTS speed */
  speed?: number;
  /** TTS pitch */
  pitch?: number;
  /** Output audio format for channel */
  outputFormat?: AudioFormat;
  /** Enable voice conversation mode (continuous STT → agent → TTS loop) */
  conversationMode?: boolean;
  /** Max silence duration (ms) before ending conversation mode */
  conversationSilenceMs?: number;
}

// ── Voice conversation types ──

export interface VoiceConversationState {
  sessionId: string;
  agentId: string;
  channelId: string;
  active: boolean;
  startedAt: number;
  lastActivityAt: number;
  turnCount: number;
}
