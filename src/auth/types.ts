// Authentication types for Anorion

export interface User {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type UserRole = 'admin' | 'operator' | 'viewer' | 'agent';

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  /** SHA-256 hash of the raw key */
  keyHash: string;
  /** Key prefix for identification (e.g. "anr_a1b2") */
  keyPrefix: string;
  scopes: ApiKeyScope[];
  enabled: boolean;
  /** Per-key rate limits */
  rateLimits?: {
    rpm?: number;  // requests per minute
    tpm?: number;  // tokens per minute
  };
  lastUsed: number;
  createdAt: number;
}

export type ApiKeyScope = 'read' | 'write' | 'admin';

export interface JwtPayload {
  sub: string;       // user ID
  username: string;
  role: UserRole;
  scopes: ApiKeyScope[];
  iat: number;
  exp: number;
}

export interface AuthContext {
  userId: string;
  username: string;
  role: UserRole;
  scopes: ApiKeyScope[];
  /** If authed via API key, the key ID */
  apiKeyId?: string;
}

export interface LoginRequest {
  apiKey: string;
}

export interface RegisterRequest {
  username: string;
  email?: string;
  role?: UserRole;
}

export interface CreateKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  rateLimits?: { rpm?: number; tpm?: number };
}
