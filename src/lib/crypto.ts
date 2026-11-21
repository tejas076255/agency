// Small Web Crypto helpers. Works in Workers and in Node 20+ (used by tests).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToString(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return decoder.decode(base64ToBytes(padded));
}

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE S256 code challenge for a code verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/** Constant-time string comparison (for CSRF tokens etc.). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- AES-GCM encryption for secrets at rest (Google refresh tokens) ----------

const keyCache = new Map<string, Promise<CryptoKey>>();

function importAesKey(base64Key: string): Promise<CryptoKey> {
  const cached = keyCache.get(base64Key);
  if (cached) return cached;
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded');
  }
  const key = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  keyCache.set(base64Key, key);
  return key;
}

/**
 * Key ring for rotation: new data is always encrypted with `current`;
 * `previous` (optional) can still decrypt data written before a key rotation.
 */
export type KeyRing = { current: { id: string; key: string }; previous?: { id: string; key: string } };

const DEFAULT_KEY_ID = 'k1';

/**
 * Builds the key ring from Worker env:
 *  TOKEN_ENCRYPTION_KEY          current key (base64, 32 bytes)
 *  TOKEN_ENCRYPTION_KEY_ID       its id, default "k1"
 *  TOKEN_ENCRYPTION_KEY_PREVIOUS optional "<id>:<base64 key>" of the old key during rotation
 */
export function keyRingFromEnv(env: {
  TOKEN_ENCRYPTION_KEY: string;
  TOKEN_ENCRYPTION_KEY_ID?: string;
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
}): KeyRing {
  const ring: KeyRing = {
    current: { id: env.TOKEN_ENCRYPTION_KEY_ID || DEFAULT_KEY_ID, key: env.TOKEN_ENCRYPTION_KEY },
  };
  const prev = env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (prev) {
    const i = prev.indexOf(':');
    if (i <= 0) throw new Error('TOKEN_ENCRYPTION_KEY_PREVIOUS must look like "<id>:<base64 key>"');
    ring.previous = { id: prev.slice(0, i), key: prev.slice(i + 1) };
  }
  return ring;
}

const toRing = (k: string | KeyRing): KeyRing =>
  typeof k === 'string' ? { current: { id: DEFAULT_KEY_ID, key: k } } : k;

/**
 * Encrypts a secret with AES-256-GCM and a fresh random 96-bit IV.
 * Output format: "v2.<keyId>.<base64 iv>.<base64 ciphertext+tag>"
 */
export async function encryptSecret(plaintext: string, keys: string | KeyRing): Promise<string> {
  const { current } = toRing(keys);
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(current.id)) throw new Error('Invalid encryption key id');
  const key = await importAesKey(current.key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  return `v2.${current.id}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

async function decryptWith(base64Key: string, ivB64: string, ctB64: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64),
  );
  return decoder.decode(plaintext);
}

/**
 * Decrypts output of encryptSecret. Throws if the data was tampered with, the key is wrong,
 * or the key id is unknown. Also reads the legacy "v1.<iv>.<ct>" format (no key id).
 */
export async function decryptSecret(payload: string, keys: string | KeyRing): Promise<string> {
  const ring = toRing(keys);
  const parts = payload.split('.');
  if (parts[0] === 'v2' && parts.length === 4) {
    const [, keyId, ivB64, ctB64] = parts as [string, string, string, string];
    const k = [ring.current, ring.previous].find((x) => x?.id === keyId);
    if (!k) throw new Error(`Unknown encryption key id "${keyId}"`);
    return decryptWith(k.key, ivB64, ctB64);
  }
  if (parts[0] === 'v1' && parts.length === 3) {
    const [, ivB64, ctB64] = parts as [string, string, string];
    try {
      return await decryptWith(ring.current.key, ivB64, ctB64);
    } catch (err) {
      if (!ring.previous) throw err;
      return decryptWith(ring.previous.key, ivB64, ctB64);
    }
  }
  throw new Error('Invalid encrypted payload');
}

/** True when data should be re-encrypted with the current key (legacy format or old key). */
export function needsReencryption(payload: string, keys: string | KeyRing): boolean {
  const ring = toRing(keys);
  return !payload.startsWith(`v2.${ring.current.id}.`);
}
