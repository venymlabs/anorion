// Audio format conversion utilities using ffmpeg (via Bun subprocess)
// Converts between ogg, mp3, wav, webm, pcm formats

import type { AudioData, AudioFormat } from './types';
import { logger } from '../shared/logger';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'fs/promises';

const FORMAT_EXTENSIONS: Record<AudioFormat, string> = {
  mp3: '.mp3',
  ogg: '.ogg',
  wav: '.wav',
  webm: '.webm',
  pcm: '.pcm',
};

const FORMAT_MIME: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  pcm: 'audio/pcm',
};

export function mimeTypeForFormat(format: AudioFormat): string {
  return FORMAT_MIME[format];
}

export function extensionForFormat(format: AudioFormat): string {
  return FORMAT_EXTENSIONS[format];
}

/** Detect audio format from a buffer's magic bytes */
export function detectFormat(buffer: Buffer): AudioFormat | null {
  if (buffer.length < 4) return null;

  const b0 = buffer[0]!;
  const b1 = buffer[1]!;
  const b2 = buffer[2]!;
  const b3 = buffer[3]!;

  // MP3: ID3 tag or sync word
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return 'mp3'; // ID3
  if (b0 === 0xFF && (b1 & 0xE0) === 0xE0) return 'mp3'; // sync

  // OGG: OggS
  if (b0 === 0x4F && b1 === 0x67 && b2 === 0x67 && b3 === 0x53) return 'ogg';

  // WAV: RIFF....WAVE
  if (
    buffer.length >= 12 &&
    b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45
  ) return 'wav';

  // WebM: 0x1A 0x45 0xDF 0xA3
  if (b0 === 0x1A && b1 === 0x45 && b2 === 0xDF && b3 === 0xA3) return 'webm';

  return null;
}

/** Check if ffmpeg is available */
let _ffmpegAvailable: boolean | null = null;

export async function isFfmpegAvailable(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  try {
    const proc = Bun.spawn(['ffmpeg', '-version'], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    _ffmpegAvailable = proc.exitCode === 0;
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

/**
 * Convert audio between formats using ffmpeg.
 * Returns a new AudioData with the converted buffer.
 */
export async function convertAudio(
  input: AudioData,
  targetFormat: AudioFormat,
  options?: { sampleRate?: number; channels?: number; bitrate?: string },
): Promise<AudioData> {
  if (input.format === targetFormat && !options?.sampleRate && !options?.channels) {
    return input;
  }

  if (!(await isFfmpegAvailable())) {
    throw new Error('ffmpeg is required for audio conversion but is not installed');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'anorion-audio-'));
  const inputExt = FORMAT_EXTENSIONS[input.format];
  const outputExt = FORMAT_EXTENSIONS[targetFormat];
  const inputPath = join(workDir, `input${inputExt}`);
  const outputPath = join(workDir, `output${outputExt}`);

  try {
    await writeFile(inputPath, input.buffer);

    const args = ['-i', inputPath, '-y'];

    if (options?.sampleRate) args.push('-ar', String(options.sampleRate));
    if (options?.channels) args.push('-ac', String(options.channels));
    if (options?.bitrate) args.push('-b:a', options.bitrate);

    // Codec selection for target format
    if (targetFormat === 'ogg') {
      args.push('-c:a', 'libopus'); // Opus in OGG container (Telegram voice note format)
    } else if (targetFormat === 'mp3') {
      args.push('-c:a', 'libmp3lame');
    } else if (targetFormat === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    }

    args.push(outputPath);

    const proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`ffmpeg conversion failed: ${stderr.slice(0, 500)}`);
    }

    const outputBuffer = await readFile(outputPath);

    // Get duration if possible
    let durationMs: number | undefined;
    try {
      const probe = Bun.spawn([
        'ffprobe', '-i', outputPath, '-show_entries', 'format=duration',
        '-v', 'quiet', '-of', 'csv=p=0',
      ], { stdout: 'pipe', stderr: 'pipe' });
      const probeExit = await probe.exited;
      if (probeExit === 0) {
        const durStr = await new Response(probe.stdout).text();
        durationMs = Math.round(parseFloat(durStr.trim()) * 1000);
      }
    } catch { /* ignore */ }

    return {
      buffer: Buffer.from(outputBuffer),
      format: targetFormat,
      sampleRate: options?.sampleRate,
      channels: options?.channels,
      durationMs: durationMs ?? input.durationMs,
    };
  } finally {
    // Cleanup temp files
    for (const f of [inputPath, outputPath]) {
      try { await unlink(f); } catch { /* ignore */ }
    }
    try { await rmdir(workDir); } catch { /* ignore */ }
  }
}

/**
 * Get audio duration in milliseconds using ffprobe.
 */
export async function getAudioDuration(buffer: Buffer, format: AudioFormat): Promise<number | null> {
  if (!(await isFfmpegAvailable())) return null;

  const workDir = await mkdtemp(join(tmpdir(), 'anorion-audio-'));
  const filePath = join(workDir, `audio${FORMAT_EXTENSIONS[format]}`);

  try {
    await writeFile(filePath, buffer);
    const proc = Bun.spawn([
      'ffprobe', '-i', filePath, '-show_entries', 'format=duration',
      '-v', 'quiet', '-of', 'csv=p=0',
    ], { stdout: 'pipe', stderr: 'pipe' });

    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const durStr = await new Response(proc.stdout).text();
    const dur = parseFloat(durStr.trim());
    return Number.isNaN(dur) ? null : Math.round(dur * 1000);
  } catch {
    return null;
  } finally {
    try { await unlink(filePath); } catch { /* ignore */ }
    try { await rmdir(workDir); } catch { /* ignore */ }
  }
}

/**
 * Segment text into sentence chunks for TTS.
 * Respects sentence boundaries and max length.
 */
export function segmentText(text: string, maxLength = 500): string[] {
  if (text.length <= maxLength) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      segments.push(remaining.trim());
      break;
    }

    // Try to split at sentence boundaries within the max length window
    const window = remaining.slice(0, maxLength);
    let splitAt = -1;

    // Look for sentence-ending punctuation
    for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n', '.\t']) {
      const idx = window.lastIndexOf(sep);
      if (idx > splitAt) splitAt = idx + sep.length;
    }

    // Fallback to newline or comma
    if (splitAt <= 0) {
      const nlIdx = window.lastIndexOf('\n');
      if (nlIdx > maxLength * 0.3) {
        splitAt = nlIdx + 1;
      } else {
        const commaIdx = window.lastIndexOf(', ');
        if (commaIdx > maxLength * 0.3) {
          splitAt = commaIdx + 2;
        } else {
          // Last resort: split at space
          const spaceIdx = window.lastIndexOf(' ');
          splitAt = spaceIdx > 0 ? spaceIdx + 1 : maxLength;
        }
      }
    }

    const segment = remaining.slice(0, splitAt).trim();
    if (segment) segments.push(segment);
    remaining = remaining.slice(splitAt);
  }

  return segments.filter(Boolean);
}
