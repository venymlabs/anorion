// API Key CRUD — in-memory store with optional SQLite persistence

import type { ApiKey, ApiKeyScope } from './types';

function hashKey(rawKey: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(rawKey);
  return hasher.digest('hex');
}

function generateRawKey(): string {
  return `anr_${crypto.randomUUID().replace(/-/g, '')}`;
}

// In-memory key store
const memoryKeys = new Map<string, ApiKey>();

export function createApiKeyMemory(userId: string, name: string, scopes: ApiKeyScope[]): { key: string; apiKey: ApiKey } {
  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);
  const id = crypto.randomUUID();
  const now = Date.now();

  const apiKey: ApiKey = {
    id,
    userId,
    name,
    keyHash,
    keyPrefix: rawKey.slice(0, 8),
    scopes,
    enabled: true,
    lastUsed: 0,
    createdAt: now,
  };

  memoryKeys.set(keyHash, apiKey);
  return { key: rawKey, apiKey };
}

export function verifyApiKeyMemory(rawKey: string): ApiKey | null {
  const keyHash = hashKey(rawKey);
  const entry = memoryKeys.get(keyHash);
  if (!entry || !entry.enabled) return null;
  entry.lastUsed = Date.now();
  return entry;
}

export function listApiKeysMemory(): ApiKey[] {
  return [...memoryKeys.values()];
}

export function revokeApiKeyMemory(id: string): boolean {
  for (const [hash, key] of memoryKeys) {
    if (key.id === id) {
      memoryKeys.delete(hash);
      return true;
    }
  }
  return false;
}
