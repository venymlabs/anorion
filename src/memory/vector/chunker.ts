// Chunking Strategies — split documents/content into embeddable chunks

export interface Chunk {
  content: string;
  index: number;
  /** Character offset in the original text */
  startOffset: number;
  /** Estimated token count (~4 chars per token) */
  estimatedTokens: number;
  metadata?: Record<string, unknown>;
}

export interface ChunkerConfig {
  chunkSize: number;
  chunkOverlap: number;
}

const ESTIMATE_TOKENS = (chars: number) => Math.ceil(chars / 4);

/** Split text into fixed-size chunks with overlap */
export function fixedSizeChunks(text: string, config: ChunkerConfig): Chunk[] {
  const { chunkSize, chunkOverlap } = config;
  if (text.length <= chunkSize) {
    return [{
      content: text,
      index: 0,
      startOffset: 0,
      estimatedTokens: ESTIMATE_TOKENS(text.length),
    }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    let content = text.slice(start, end);

    // Try to break at sentence/paragraph boundary
    if (end < text.length) {
      const lastPeriod = content.lastIndexOf('.');
      const lastNewline = content.lastIndexOf('\n');
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > chunkSize * 0.5) {
        content = text.slice(start, start + breakPoint + 1);
      }
    }

    chunks.push({
      content: content.trim(),
      index,
      startOffset: start,
      estimatedTokens: ESTIMATE_TOKENS(content.length),
    });

    start += content.length - chunkOverlap;
    if (start <= chunks[chunks.length - 1]!.startOffset) {
      start = chunks[chunks.length - 1]!.startOffset + 1;
    }
    index++;
  }

  return chunks;
}

/** Split markdown into chunks respecting heading boundaries */
export function markdownChunks(text: string, config: ChunkerConfig): Chunk[] {
  const sections: Array<{ heading: string; content: string; startOffset: number }> = [];
  const lines = text.split('\n');
  let currentHeading = '';
  let currentContent: string[] = [];
  let currentOffset = 0;

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n'),
          startOffset: currentOffset,
        });
      }
      currentHeading = line.replace(/^#{1,6}\s+/, '').trim();
      currentContent = [line];
      currentOffset += line.length + 1;
    } else {
      currentContent.push(line);
      currentOffset += line.length + 1;
    }
  }

  if (currentContent.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n'),
      startOffset: currentOffset,
    });
  }

  // Further split sections that exceed chunk size
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    if (section.content.length <= config.chunkSize) {
      chunks.push({
        content: section.content.trim(),
        index: index++,
        startOffset: section.startOffset,
        estimatedTokens: ESTIMATE_TOKENS(section.content.length),
        metadata: { heading: section.heading },
      });
    } else {
      const subChunks = fixedSizeChunks(section.content, config);
      for (const sc of subChunks) {
        chunks.push({
          ...sc,
          index: index++,
          startOffset: section.startOffset + sc.startOffset,
          metadata: { heading: section.heading },
        });
      }
    }
  }

  return chunks;
}

/** Split code into chunks respecting function/class boundaries */
export function codeChunks(text: string, config: ChunkerConfig): Chunk[] {
  // Split on blank lines or common block boundaries
  const blocks = text.split(/\n\s*\n/);
  const chunks: Chunk[] = [];
  let current = '';
  let index = 0;
  let offset = 0;

  for (const block of blocks) {
    if (current.length + block.length + 1 > config.chunkSize && current.length > 0) {
      chunks.push({
        content: current.trim(),
        index: index++,
        startOffset: offset,
        estimatedTokens: ESTIMATE_TOKENS(current.length),
      });
      offset += current.length + 1;
      current = block;
    } else {
      current = current ? current + '\n\n' + block : block;
    }
  }

  if (current.trim()) {
    chunks.push({
      content: current.trim(),
      index: index++,
      startOffset: offset,
      estimatedTokens: ESTIMATE_TOKENS(current.length),
    });
  }

  return chunks;
}

/** Auto-detect content type and chunk accordingly */
export function autoChunk(
  text: string,
  config: ChunkerConfig,
  contentType?: 'text' | 'markdown' | 'code',
): Chunk[] {
  if (contentType === 'markdown') return markdownChunks(text, config);
  if (contentType === 'code') return codeChunks(text, config);

  // Auto-detect: check for markdown patterns
  if (/^#{1,6}\s/m.test(text) && /\n\s*\n/.test(text)) {
    return markdownChunks(text, config);
  }

  return fixedSizeChunks(text, config);
}
