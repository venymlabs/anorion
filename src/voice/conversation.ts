// Voice conversation mode — continuous STT → agent → TTS loop
// Manages voice conversation sessions for voice-enabled channels

import type { VoiceConfig } from '../shared/types';
import type { AudioData, AudioFormat, VoiceConversationState } from './types';
import { sttService } from './stt';
import { ttsService } from './tts';
import { logger } from '../shared/logger';
import { sendMessage } from '../agents/runtime';
import { eventBus } from '../shared/events';

interface ConversationSession extends VoiceConversationState {
  /** Abort controller for cancelling the conversation */
  abortController: AbortController;
  /** Last agent response text (for context) */
  lastResponseText: string;
  /** Voice config resolved for this session */
  voiceConfig: Required<Pick<VoiceConfig, 'ttsProvider' | 'sttProvider' | 'voice' | 'language' | 'speed' | 'pitch' | 'outputFormat'>> &
    VoiceConfig;
}

class VoiceConversationManager {
  private sessions = new Map<string, ConversationSession>();

  /**
   * Start a voice conversation session.
   */
  startSession(opts: {
    sessionId: string;
    agentId: string;
    channelId: string;
    voiceConfig: VoiceConfig;
  }): ConversationSession {
    // End existing session for this channel if any
    const existing = this.findSessionByChannel(opts.channelId);
    if (existing) {
      this.endSession(existing.sessionId);
    }

    const session: ConversationSession = {
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      channelId: opts.channelId,
      active: true,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      turnCount: 0,
      lastResponseText: '',
      abortController: new AbortController(),
      voiceConfig: {
        enabled: true,
        ttsProvider: opts.voiceConfig.ttsProvider || 'edge-tts',
        sttProvider: opts.voiceConfig.sttProvider || 'openai-whisper',
        voice: opts.voiceConfig.voice || 'en-US-AvaNeural',
        language: opts.voiceConfig.language || 'en-US',
        speed: opts.voiceConfig.speed ?? 1.0,
        pitch: opts.voiceConfig.pitch ?? 0,
        outputFormat: opts.voiceConfig.outputFormat || 'ogg',
      },
    };

    this.sessions.set(session.sessionId, session);
    logger.info({ sessionId: session.sessionId, agentId: opts.agentId }, 'Voice conversation started');

    eventBus.emit('voice:conversation:started', {
      sessionId: session.sessionId,
      agentId: opts.agentId,
      channelId: opts.channelId,
      timestamp: Date.now(),
    });

    return session;
  }

  /**
   * Process a single voice turn: transcribe → agent → synthesize.
   * Returns the TTS audio for the agent's response along with texts.
   */
  async processTurn(
    sessionId: string,
    audio: AudioData,
  ): Promise<{ audio: AudioData; text: string; transcription: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      logger.warn({ sessionId }, 'No active voice conversation session');
      return null;
    }

    if (session.abortController.signal.aborted) {
      return null;
    }

    try {
      // 1. STT: transcribe user audio
      const sttResult = await sttService.transcribe(audio, {
        language: session.voiceConfig.language,
        adapter: session.voiceConfig.sttProvider,
      });

      const userText = sttResult.text.trim();
      if (!userText) {
        logger.debug({ sessionId }, 'Empty transcription, skipping turn');
        return null;
      }

      logger.info({ sessionId, text: userText, language: sttResult.language }, 'Voice turn transcribed');
      session.lastActivityAt = Date.now();

      eventBus.emit('voice:turn:transcribed', {
        sessionId,
        agentId: session.agentId,
        transcription: userText,
        language: sttResult.language,
        confidence: sttResult.confidence,
        timestamp: Date.now(),
      });

      // 2. Agent: process the transcribed text
      const agentResult = await sendMessage({
        agentId: session.agentId,
        text: userText,
        channelId: session.channelId,
        sessionId: session.sessionId,
        abortSignal: session.abortController.signal,
      });

      const responseText = agentResult.content;
      session.lastResponseText = responseText;
      session.turnCount++;
      session.lastActivityAt = Date.now();

      logger.info(
        { sessionId, turnCount: session.turnCount, responseLength: responseText.length },
        'Voice turn agent response',
      );

      eventBus.emit('voice:turn:agent-response', {
        sessionId,
        agentId: session.agentId,
        responseText,
        durationMs: Date.now() - session.lastActivityAt,
        timestamp: Date.now(),
      });

      // 3. TTS: synthesize agent response
      const format = (session.voiceConfig.outputFormat || 'ogg') as AudioFormat;
      const ttsResult = await ttsService.synthesize(responseText, {
        voice: session.voiceConfig.voice,
        speed: session.voiceConfig.speed,
        pitch: session.voiceConfig.pitch,
        format,
        language: session.voiceConfig.language,
        adapter: session.voiceConfig.ttsProvider,
      });

      eventBus.emit('voice:turn:tts', {
        sessionId,
        agentId: session.agentId,
        audioBytes: ttsResult.audio.buffer.length,
        durationMs: ttsResult.audio.durationMs,
        timestamp: Date.now(),
      });

      return {
        audio: ttsResult.audio,
        text: responseText,
        transcription: userText,
      };
    } catch (err) {
      logger.error({ sessionId, error: (err as Error).message }, 'Voice conversation turn failed');
      eventBus.emit('voice:conversation:error', {
        sessionId,
        agentId: session.agentId,
        error: (err as Error).message,
        timestamp: Date.now(),
      });
      return null;
    }
  }

  /**
   * Process a text-based turn (user typed instead of speaking).
   */
  async processTextTurn(
    sessionId: string,
    text: string,
  ): Promise<{ audio: AudioData; text: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) return null;

    try {
      const agentResult = await sendMessage({
        agentId: session.agentId,
        text,
        channelId: session.channelId,
        sessionId: session.sessionId,
        abortSignal: session.abortController.signal,
      });

      const responseText = agentResult.content;
      session.lastResponseText = responseText;
      session.turnCount++;
      session.lastActivityAt = Date.now();

      const format = (session.voiceConfig.outputFormat || 'ogg') as AudioFormat;
      const ttsResult = await ttsService.synthesize(responseText, {
        voice: session.voiceConfig.voice,
        speed: session.voiceConfig.speed,
        pitch: session.voiceConfig.pitch,
        format,
        language: session.voiceConfig.language,
        adapter: session.voiceConfig.ttsProvider,
      });

      return { audio: ttsResult.audio, text: responseText };
    } catch (err) {
      logger.error({ sessionId, error: (err as Error).message }, 'Voice text turn failed');
      return null;
    }
  }

  /**
   * End a voice conversation session.
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.active = false;
    session.abortController.abort();
    this.sessions.delete(sessionId);

    const durationMs = Date.now() - session.startedAt;
    logger.info(
      { sessionId, turns: session.turnCount, durationMs },
      'Voice conversation ended',
    );

    eventBus.emit('voice:conversation:ended', {
      sessionId,
      agentId: session.agentId,
      turns: session.turnCount,
      durationMs,
      timestamp: Date.now(),
    });
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.active ?? false;
  }

  getSession(sessionId: string): ConversationSession | undefined {
    return this.sessions.get(sessionId);
  }

  findSessionByChannel(channelId: string): ConversationSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId && session.active) return session;
    }
    return undefined;
  }

  /** End sessions idle longer than maxIdleMs (default 5 minutes) */
  cleanupIdleSessions(maxIdleMs = 300_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > maxIdleMs) {
        this.endSession(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  listActiveSessions(): Array<{
    sessionId: string;
    agentId: string;
    channelId: string;
    turnCount: number;
    startedAt: number;
  }> {
    return [...this.sessions.values()]
      .filter((s) => s.active)
      .map((s) => ({
        sessionId: s.sessionId,
        agentId: s.agentId,
        channelId: s.channelId,
        turnCount: s.turnCount,
        startedAt: s.startedAt,
      }));
  }
}

export const voiceConversation = new VoiceConversationManager();
