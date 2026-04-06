// Embedding Generation — uses the AI SDK to generate embeddings via provider registry

import { embed, embedMany } from 'ai';
import { resolveModel } from '../../llm/providers';
import { logger } from '../../shared/logger';

export interface EmbeddingResult {
  vector: number[];
  tokenCount: number;
}

/** Cache of embedding model instances */
const modelCache = new Map<string, any>();

function getEmbeddingModel(modelStr: string) {
  if (modelCache.has(modelStr)) return modelCache.get(modelStr);

  const resolved = resolveModel(modelStr);
  modelCache.set(modelStr, resolved.instance);
  return resolved.instance;
}

/** Generate an embedding for a single text */
export async function generateEmbedding(text: string, modelStr: string): Promise<EmbeddingResult> {
  const model = getEmbeddingModel(modelStr);
  const start = Date.now();

  const result = await embed({
    model,
    value: text,
  });

  const duration = Date.now() - start;
  logger.debug({ model: modelStr, tokens: result.usage?.tokens, durationMs: duration }, 'Embedding generated');

  return {
    vector: result.embedding,
    tokenCount: result.usage?.tokens ?? 0,
  };
}

/** Generate embeddings for multiple texts in batch */
export async function generateEmbeddings(
  texts: string[],
  modelStr: string,
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const model = getEmbeddingModel(modelStr);
  const start = Date.now();

  const result = await embedMany({
    model,
    values: texts,
  });

  const duration = Date.now() - start;
  logger.debug({
    model: modelStr,
    count: texts.length,
    tokens: result.usage?.tokens,
    durationMs: duration,
  }, 'Batch embeddings generated');

  return result.embeddings.map((vector, i) => ({
    vector,
    tokenCount: result.usage?.tokens ?? 0,
  }));
}

/** Detect vector dimensions from a model by embedding a test string */
export async function detectDimensions(modelStr: string): Promise<number> {
  const result = await generateEmbedding('test', modelStr);
  return result.vector.length;
}
