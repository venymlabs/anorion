// API Key RBAC — scoped API key authorization with role-based access control

export type Permission =
  | 'agents:read'
  | 'agents:write'
  | 'agents:delete'
  | 'messages:send'
  | 'messages:read'
  | 'sessions:read'
  | 'sessions:manage'
  | 'tools:read'
  | 'tools:execute'
  | 'memory:read'
  | 'memory:write'
  | 'memory:delete'
  | 'schedules:read'
  | 'schedules:manage'
  | 'bridge:read'
  | 'bridge:admin'
  | 'channels:read'
  | 'channels:manage'
  | 'pipelines:read'
  | 'pipelines:execute'
  | 'audit:read'
  | 'metrics:read'
  | 'admin'; // admin = all permissions

export type Role = 'admin' | 'operator' | 'viewer' | 'agent' | 'custom';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['admin'],
  operator: [
    'agents:read', 'agents:write', 'agents:delete',
    'messages:send', 'messages:read',
    'sessions:read', 'sessions:manage',
    'tools:read', 'tools:execute',
    'memory:read', 'memory:write', 'memory:delete',
    'schedules:read', 'schedules:manage',
    'bridge:read', 'bridge:admin',
    'channels:read', 'channels:manage',
    'pipelines:read', 'pipelines:execute',
    'audit:read', 'metrics:read',
  ],
  viewer: [
    'agents:read', 'messages:read', 'sessions:read',
    'tools:read', 'memory:read', 'schedules:read',
    'bridge:read', 'channels:read', 'pipelines:read',
    'audit:read', 'metrics:read',
  ],
  agent: [
    'messages:send', 'messages:read',
    'tools:read', 'tools:execute',
    'memory:read', 'memory:write',
    'pipelines:execute',
  ],
  custom: [],
};

export interface ApiKeyEntry {
  id: string;
  name: string;
  /** SHA-256 hash of the key */
  keyHash: string;
  /** Role name */
  role: Role;
  /** Specific permissions (overrides role if set) */
  permissions: Permission[];
  /** Enabled */
  enabled: boolean;
  /** Last used timestamp */
  lastUsed: number;
  createdAt: number;
}

class ApiKeyManager {
  private keys = new Map<string, ApiKeyEntry>(); // keyHash -> entry

  /** Create a new API key */
  create(input: { name: string; role: Role; permissions?: Permission[] }): { entry: ApiKeyEntry; key: string } {
    const rawKey = `anr_${crypto.randomUUID().replace(/-/g, '')}`;
    const keyHash = this.hashKey(rawKey);
    const now = Date.now();

    const entry: ApiKeyEntry = {
      id: crypto.randomUUID(),
      name: input.name,
      keyHash,
      role: input.role,
      permissions: input.permissions || ROLE_PERMISSIONS[input.role],
      enabled: true,
      lastUsed: 0,
      createdAt: now,
    };

    this.keys.set(keyHash, entry);
    return { entry, key: rawKey };
  }

  /** Authenticate a request — returns the key entry or null */
  authenticate(rawKey: string): ApiKeyEntry | null {
    const hash = this.hashKey(rawKey);
    const entry = this.keys.get(hash);
    if (!entry || !entry.enabled) return null;
    entry.lastUsed = Date.now();
    return entry;
  }

  /** Check if a key has a specific permission */
  hasPermission(entry: ApiKeyEntry, permission: Permission): boolean {
    if (entry.permissions.includes('admin')) return true;
    if (entry.permissions.includes(permission)) return true;
    return false;
  }

  /** Check if a key has any of the given permissions */
  hasAnyPermission(entry: ApiKeyEntry, permissions: Permission[]): boolean {
    return permissions.some((p) => this.hasPermission(entry, p));
  }

  /** Revoke a key */
  revoke(keyHash: string): boolean {
    return this.keys.delete(keyHash);
  }

  /** Disable a key without removing */
  setEnabled(keyHash: string, enabled: boolean): boolean {
    const entry = this.keys.get(keyHash);
    if (!entry) return false;
    entry.enabled = enabled;
    return true;
  }

  /** List all keys (without hashes) */
  list(): Array<Omit<ApiKeyEntry, 'keyHash'>> {
    return [...this.keys.values()].map(({ keyHash: _, ...rest }) => rest);
  }

  /** Get available roles and their permissions */
  getRoles(): Record<Role, Permission[]> {
    return { ...ROLE_PERMISSIONS };
  }

  private hashKey(key: string): string {
    // Use Bun's built-in crypto
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(key);
    return hasher.digest('hex');
  }
}

export const apiKeyManager = new ApiKeyManager();
