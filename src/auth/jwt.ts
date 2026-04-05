// JWT sign/verify using Web Crypto API — no external dependencies

import type { JwtPayload, UserRole, ApiKeyScope } from './types';

const JWT_ALG = 'HS256';
const JWT_ISS = 'anorion';
const DEFAULT_EXPIRY_S = 3600; // 1 hour

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

let _jwtSecret: string | null = null;

export function setJwtSecret(secret: string): void {
  _jwtSecret = secret;
}

function getJwtSecret(): string {
  if (!_jwtSecret) {
    _jwtSecret = process.env.JWT_SECRET || 'anorion-dev-secret-change-me';
  }
  return _jwtSecret;
}

export async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss'>, expiresInSeconds = DEFAULT_EXPIRY_S): Promise<string> {
  const header = b64url(textToBytes(JSON.stringify({ alg: JWT_ALG, typ: 'JWT' })));

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const payloadB64 = b64url(textToBytes(JSON.stringify({ ...fullPayload, iss: JWT_ISS })));
  const signingInput = `${header}.${payloadB64}`;

  const key = await getKey(getJwtSecret());
  const sig = await crypto.subtle.sign('HMAC', key, textToBytes(signingInput));

  return `${signingInput}.${b64url(sig)}`;
}

export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;
  const signingInput = `${headerB64}.${payloadB64}`;

  try {
    const key = await getKey(getJwtSecret());
    const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigB64), textToBytes(signingInput));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as JwtPayload & { iss?: string };
    if (payload.iss !== JWT_ISS) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
