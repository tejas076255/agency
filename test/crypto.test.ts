import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  decryptSecret,
  encryptSecret,
  pkceChallenge,
  randomToken,
  timingSafeEqual,
} from '../src/lib/crypto';

const key = () => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

describe('token encryption (AES-GCM)', () => {
  it('round-trips a refresh token', async () => {
    const k = key();
    const secret = '1//0gExampleRefreshToken-abc_123';
    const encrypted = await encryptSecret(secret, k);
    expect(encrypted.startsWith('v1.')).toBe(true);
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
    const [v, iv, ct] = encrypted.split('.');
    const bytes = Uint8Array.from(atob(ct!), (ch) => ch.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = `${v}.${iv}.${bytesToBase64(bytes)}`;
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
