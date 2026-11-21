import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  decryptSecret,
  encryptSecret,
  pkceChallenge,
  randomToken,
  timingSafeEqual,
  keyRingFromEnv,
  needsReencryption,
} from '../src/lib/crypto';

const key = () => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

/** Legacy v1 format ("v1.<iv>.<ct>"), as written before key versioning existed. */
async function encryptV1(plaintext: string, base64Key: string) {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plaintext));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

describe('encryption key versioning / rotation', () => {
  it('stores the key id inside the ciphertext', async () => {
    const ring = keyRingFromEnv({ TOKEN_ENCRYPTION_KEY: key(), TOKEN_ENCRYPTION_KEY_ID: 'k7' });
    expect((await encryptSecret('x', ring)).startsWith('v2.k7.')).toBe(true);
  });

  it('decrypts data written with the previous key after rotation', async () => {
    const oldKey = key();
    const newKey = key();
    const oldRing = keyRingFromEnv({ TOKEN_ENCRYPTION_KEY: oldKey, TOKEN_ENCRYPTION_KEY_ID: 'k1' });
    const written = await encryptSecret('refresh-token', oldRing);
    const rotated = keyRingFromEnv({
      TOKEN_ENCRYPTION_KEY: newKey,
      TOKEN_ENCRYPTION_KEY_ID: 'k2',
      TOKEN_ENCRYPTION_KEY_PREVIOUS: `k1:${oldKey}`,
    });
    expect(await decryptSecret(written, rotated)).toBe('refresh-token');
    expect(needsReencryption(written, rotated)).toBe(true);
    const reEncrypted = await encryptSecret('refresh-token', rotated);
    expect(needsReencryption(reEncrypted, rotated)).toBe(false);
  });

  it('fails for an unknown key id (old key removed too early)', async () => {
    const written = await encryptSecret('x', keyRingFromEnv({ TOKEN_ENCRYPTION_KEY: key(), TOKEN_ENCRYPTION_KEY_ID: 'k1' }));
    const ring = keyRingFromEnv({ TOKEN_ENCRYPTION_KEY: key(), TOKEN_ENCRYPTION_KEY_ID: 'k2' });
    await expect(decryptSecret(written, ring)).rejects.toThrow(/Unknown encryption key id "k1"/);
  });

  it('still reads the legacy v1 format (current key, then previous key)', async () => {
    const k1 = key();
    const legacy = await encryptV1('legacy-secret', k1);
    expect(await decryptSecret(legacy, k1)).toBe('legacy-secret');
    const rotated = keyRingFromEnv({ TOKEN_ENCRYPTION_KEY: key(), TOKEN_ENCRYPTION_KEY_ID: 'k2', TOKEN_ENCRYPTION_KEY_PREVIOUS: `k1:${k1}` });
    expect(await decryptSecret(legacy, rotated)).toBe('legacy-secret');
    expect(needsReencryption(legacy, rotated)).toBe(true);
  });

  it('rejects a malformed previous-key setting', () => {
    expect(() => keyRingFromEnv({ TOKEN_ENCRYPTION_KEY: key(), TOKEN_ENCRYPTION_KEY_PREVIOUS: 'no-colon' })).toThrow();
  });
});

describe('token encryption (AES-GCM)', () => {
  it('round-trips a refresh token', async () => {
    const k = key();
    const secret = '1//0gExampleRefreshToken-abc_123';
    const encrypted = await encryptSecret(secret, k);
    expect(encrypted.startsWith('v2.k1.')).toBe(true);
    expect(encrypted).not.toContain(secret);
    expect(await decryptSecret(encrypted, k)).toBe(secret);
  });

  it('uses a fresh IV every time (same input -> different ciphertext)', async () => {
    const k = key();
    const a = await encryptSecret('same', k);
    const b = await encryptSecret('same', k);
    expect(a).not.toBe(b);
  });

  it('fails with the wrong key', async () => {
    const encrypted = await encryptSecret('secret', key());
    await expect(decryptSecret(encrypted, key())).rejects.toThrow();
  });

  it('fails if the ciphertext is tampered with', async () => {
    const k = key();
    const encrypted = await encryptSecret('secret', k);
    const [v, keyId, iv, ct] = encrypted.split('.');
    const bytes = Uint8Array.from(atob(ct!), (ch) => ch.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = `${v}.${keyId}.${iv}.${bytesToBase64(bytes)}`;
    await expect(decryptSecret(tampered, k)).rejects.toThrow();
  });

  it('rejects malformed payloads and bad keys', async () => {
    await expect(decryptSecret('not-encrypted', key())).rejects.toThrow(
      'Invalid encrypted payload',
    );
    await expect(encryptSecret('x', bytesToBase64(new Uint8Array(16)))).rejects.toThrow(
      /32 random bytes/,
    );
  });
});

describe('random tokens, PKCE and comparisons', () => {
  it('creates URL-safe unique tokens', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(t);
  });

  it('computes the RFC 7636 example PKCE challenge', async () => {
    // Test vector from RFC 7636 Appendix B.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('timingSafeEqual compares correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
