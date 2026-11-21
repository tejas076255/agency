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
 * Encrypts a secret with AES-256-GCM and a fresh random 96-bit IV.
 * Output format: "v1.<base64 iv>.<base64 ciphertext+tag>"
 */
export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypts output of encryptSecret. Throws if the data was tampered with or the key is wrong. */
export async function decryptSecret(payload: string, base64Key: string): Promise<string> {
  const [version, ivB64, ctB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('Invalid encrypted payload');
  const key = await importAesKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64),
  );
  return decoder.decode(plaintext);
}
