import { z } from 'zod';
import type { Env } from '../env';
import { base64UrlToString, pkceChallenge, randomToken } from './crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_SECONDS = 600; // user has 10 minutes to finish the Google consent screen

export const OAUTH_STATE_COOKIE = 'oauth_state';
export const LOGIN_SCOPES = ['openid', 'email', 'profile'];

/** Data remembered between "redirect to Google" and "Google redirects back". */
const oauthStateSchema = z.object({
  purpose: z.enum(['login', 'connect_client', 'connect_agency']),
  verifier: z.string(),
  nonce: z.string(),
  userId: z.string().optional(),
  agencyId: z.string().optional(),
  clientId: z.string().optional(),
});
export type OAuthState = z.infer<typeof oauthStateSchema>;
export type OAuthPurpose = OAuthState['purpose'];

export function googleRedirectUri(env: Pick<Env, 'APP_URL'>): string {
  return `${env.APP_URL}/auth/google/callback`;
}

/**
 * Creates state + PKCE verifier + nonce, saves them in KV and returns the Google consent URL.
 * The caller must also put `state` in the OAUTH_STATE_COOKIE so the callback can confirm
 * that the same browser started the flow.
 */
export async function startGoogleOAuth(
  env: Pick<Env, 'KV' | 'APP_URL' | 'GOOGLE_CLIENT_ID'>,
  data: Omit<OAuthState, 'verifier' | 'nonce'>,
  scopes: string[],
  options: { offline?: boolean; loginHint?: string } = {},
): Promise<{ url: string; state: string }> {
  const state = randomToken(24);
  const verifier = randomToken(48); // 64 chars, within PKCE's 43-128 range
  const nonce = randomToken(16);
  const saved: OAuthState = { ...data, verifier, nonce };
  await env.KV.put(`oauth:${state}`, JSON.stringify(saved), { expirationTtl: STATE_TTL_SECONDS });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(env),
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (options.offline) {
    // Needed to receive a refresh token. prompt=consent makes Google re-issue it on reconnect.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  } else {
    params.set('prompt', 'select_account');
  }
  if (options.loginHint) params.set('login_hint', options.loginHint);
  return { url: `${AUTH_URL}?${params.toString()}`, state };
}

/** Reads and deletes (single use) the saved OAuth state. */
export async function consumeOAuthState(
  kv: KVNamespace,
  state: string,
): Promise<OAuthState | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(state)) return null;
  const key = `oauth:${state}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  const parsed = oauthStateSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});
export type GoogleTokenResponse = z.infer<typeof tokenResponseSchema>;

export class GoogleOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

/** Exchanges an authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCodeForTokens(
  env: Pick<Env, 'APP_URL' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>,
  code: string,
  verifier: string,
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(env),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GoogleOAuthError(
      String(body.error ?? 'token_exchange_failed'),
      String(body.error_description ?? `Token exchange failed (HTTP ${res.status})`),
    );
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new GoogleOAuthError('bad_token_response', 'Unexpected token response');
  return parsed.data;
}

const idTokenClaimsSchema = z.object({
  iss: z.enum(['https://accounts.google.com', 'accounts.google.com']),
  aud: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().email(),
  email_verified: z.boolean(),
  name: z.string().optional(),
  picture: z.string().url().optional(),
});
export type IdTokenClaims = z.infer<typeof idTokenClaimsSchema>;

/**
 * Validates the ID token's claims.
 * The token comes straight from Google's token endpoint over TLS (not from the browser),
 * so per OpenID Connect Core 3.1.3.7 the TLS server validation replaces signature checking.
 * We still verify issuer, audience, expiry, nonce and verified email.
 */
export function parseIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; nowSeconds?: number },
): IdTokenClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new GoogleOAuthError('bad_id_token', 'Malformed ID token');
  let json: unknown;
  try {
    json = JSON.parse(base64UrlToString(payload));
  } catch {
    throw new GoogleOAuthError('bad_id_token', 'Malformed ID token');
  }
  const parsed = idTokenClaimsSchema.safeParse(json);
  if (!parsed.success) throw new GoogleOAuthError('bad_id_token', 'ID token is missing claims');
  const claims = parsed.data;
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.aud !== expected.clientId)
    throw new GoogleOAuthError('bad_id_token', 'Wrong audience');
  if (claims.exp < now) throw new GoogleOAuthError('bad_id_token', 'ID token expired');
  if (claims.nonce !== expected.nonce) throw new GoogleOAuthError('bad_id_token', 'Nonce mismatch');
  if (!claims.email_verified) {
    throw new GoogleOAuthError('email_not_verified', 'Google email is not verified');
  }
  return claims;
}
