import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../src/lib/crypto';
import { parseIdToken } from '../src/lib/google-oauth';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const NOW = 1_800_000_000;

function makeIdToken(overrides: Record<string, unknown> = {}): string {
  const enc = (o: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    exp: NOW + 3600,
    nonce: 'nonce-1',
    email: 'owner@example.com',
    email_verified: true,
    name: 'Agency Owner',
    ...overrides,
  };
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.signature`;
}

const expected = { clientId: CLIENT_ID, nonce: 'nonce-1', nowSeconds: NOW };

describe('parseIdToken', () => {
  it('accepts a valid token', () => {
    const claims = parseIdToken(makeIdToken(), expected);
    expect(claims.sub).toBe('1234567890');
    expect(claims.email).toBe('owner@example.com');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }, 'Wrong audience'],
    ['expired', { exp: NOW - 1 }, 'expired'],
    ['nonce mismatch', { nonce: 'other' }, 'Nonce mismatch'],
    ['unverified email', { email_verified: false }, 'not verified'],
    ['wrong issuer', { iss: 'https://evil.example' }, 'missing claims'],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => parseIdToken(makeIdToken(overrides), expected)).toThrow(message);
  });

  it('rejects malformed tokens', () => {
    expect(() => parseIdToken('garbage', expected)).toThrow('Malformed');
  });
});
