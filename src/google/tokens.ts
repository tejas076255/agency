import { and, eq, isNull } from 'drizzle-orm';
import { clients, googleConnections } from '../db/schema';
import type { Env } from '../env';
import { decryptSecret, encryptSecret, keyRingFromEnv, needsReencryption } from '../lib/crypto';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { googleRequest, GoogleApiError, ReconnectNeededError } from './http';

// Minimum scopes per flow (Phase 1).
export const SCOPE = {
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  driveFile: 'https://www.googleapis.com/auth/drive.file',
  slides: 'https://www.googleapis.com/auth/presentations',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  // Phase 2 / 3
  business: 'https://www.googleapis.com/auth/business.manage',
  ads: 'https://www.googleapis.com/auth/adwords',
  youtube: 'https://www.googleapis.com/auth/youtube.readonly',
  ytAnalytics: 'https://www.googleapis.com/auth/yt-analytics.readonly',
} as const;

/** Client's Google account: read Search Console + GA4. */
export const CLIENT_DATA_SCOPES = ['openid', 'email', SCOPE.gsc, SCOPE.ga4];
/** Agency's own Google account: create the report in Slides/Drive and email it from Gmail. */
export const WORKSPACE_SCOPES = ['openid', 'email', SCOPE.driveFile, SCOPE.slides, SCOPE.gmailSend];

/**
 * Optional per-client products, each with its OWN Google connection, so a client can connect
 * e.g. only YouTube, and each product asks only for its own minimum scopes.
 */
export const CLIENT_PRODUCTS = {
  data: {
    purpose: 'client_data',
    scopes: CLIENT_DATA_SCOPES,
    required: [SCOPE.gsc, SCOPE.ga4],
    anyOf: true,
  },
  gbp: {
    purpose: 'client_business',
    scopes: ['openid', 'email', SCOPE.business],
    required: [SCOPE.business],
    anyOf: false,
  },
  ads: {
    purpose: 'client_ads',
    scopes: ['openid', 'email', SCOPE.ads],
    required: [SCOPE.ads],
    anyOf: false,
  },
  youtube: {
    purpose: 'client_youtube',
    scopes: ['openid', 'email', SCOPE.youtube, SCOPE.ytAnalytics],
    required: [SCOPE.youtube, SCOPE.ytAnalytics],
    anyOf: false,
  },
} as const;
export type ClientProduct = keyof typeof CLIENT_PRODUCTS;

/** True if the granted scopes satisfy a product (all required, or any for 'data'). */
export function grantedEnough(product: ClientProduct, granted: string[]): boolean {
  const p = CLIENT_PRODUCTS[product];
  return p.anyOf
    ? p.required.some((s) => granted.includes(s))
    : p.required.every((s) => granted.includes(s));
}

export type Connection = typeof googleConnections.$inferSelect;
export type ConnectionPurpose = Connection['purpose'];

export async function saveConnection(
  env: Env,
  input: {
    agencyId: string;
    clientId: string | null;
    purpose: ConnectionPurpose;
    googleEmail: string;
    scopes: string;
    refreshToken: string;
    userId: string;
  },
): Promise<Connection> {
  const db = getDb(env);
  const existing = await findConnections(env, input.agencyId, input.purpose, input.clientId);
  const row: Connection = {
    id: crypto.randomUUID(),
    agencyId: input.agencyId,
    clientId: input.clientId,
    purpose: input.purpose,
    googleEmail: input.googleEmail,
    scopes: input.scopes,
    encryptedRefreshToken: await encryptSecret(input.refreshToken, keyRingFromEnv(env)),
    connectedByUserId: input.userId,
    connectedAt: Date.now(),
    status: 'active',
  };
  // Replace any previous connection for the same client/purpose.
  const deletes = existing.map((c) =>
    db
      .delete(googleConnections)
      .where(and(eq(googleConnections.id, c.id), eq(googleConnections.agencyId, input.agencyId))),
  );
  await db.batch([...deletes, db.insert(googleConnections).values(row)] as unknown as Parameters<
    typeof db.batch
  >[0]);
  await Promise.all(existing.map((c) => env.KV.delete(accessTokenKey(c.id))));
  return row;
}

function findConnections(
  env: Env,
  agencyId: string,
  purpose: ConnectionPurpose,
  clientId: string | null,
) {
  return getDb(env)
    .select()
    .from(googleConnections)
    .where(
      and(
        eq(googleConnections.agencyId, agencyId),
        eq(googleConnections.purpose, purpose),
        clientId ? eq(googleConnections.clientId, clientId) : isNull(googleConnections.clientId),
      ),
    );
}

/** The current connection (active or revoked) for a client or for the agency workspace. */
export async function getConnection(
  env: Env,
  agencyId: string,
  purpose: ConnectionPurpose,
  clientId: string | null = null,
): Promise<Connection | undefined> {
  const rows = await findConnections(env, agencyId, purpose, clientId);
  return rows.sort((a, b) => b.connectedAt - a.connectedAt)[0];
}

export function hasScope(conn: Pick<Connection, 'scopes'>, scope: string): boolean {
  return conn.scopes.split(' ').includes(scope);
}

const accessTokenKey = (connectionId: string) => `gat:${connectionId}`;

/**
 * Returns a valid access token, refreshing it with the stored refresh token when needed.
 * Access tokens are cached (encrypted) in KV until shortly before they expire.
 * If Google says the refresh token is invalid/revoked, the connection is marked revoked
 * (client shows "Reconnect needed") and ReconnectNeededError is thrown.
 */
export async function getAccessToken(env: Env, conn: Connection): Promise<string> {
  if (conn.status !== 'active') throw new ReconnectNeededError();
  const ring = keyRingFromEnv(env);
  const cached = await env.KV.get(accessTokenKey(conn.id));
  if (cached) {
    try {
      return await decryptSecret(cached, ring);
    } catch {
      // Key rotated or corrupted cache: fall through and refresh.
    }
  }

  const refreshToken = await decryptSecret(conn.encryptedRefreshToken, ring);
  // Key rotation: re-encrypt the refresh token with the current key the next time it's used.
  if (needsReencryption(conn.encryptedRefreshToken, ring)) {
    await getDb(env)
      .update(googleConnections)
      .set({ encryptedRefreshToken: await encryptSecret(refreshToken, ring) })
      .where(and(eq(googleConnections.id, conn.id), eq(googleConnections.agencyId, conn.agencyId)));
  }
  let data: { access_token: string; expires_in: number };
  try {
    data = await googleRequest('https://oauth2.googleapis.com/token', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
  } catch (err) {
    if (err instanceof GoogleApiError && (err.reason === 'invalid_grant' || err.status === 401)) {
      await markRevoked(env, conn);
      throw new ReconnectNeededError();
    }
    throw err;
  }

  const ttl = Math.max(60, data.expires_in - 300);
  await env.KV.put(accessTokenKey(conn.id), await encryptSecret(data.access_token, ring), {
    expirationTtl: ttl,
  });
  return data.access_token;
}

export async function markRevoked(env: Env, conn: Connection) {
  const db = getDb(env);
  await db
    .update(googleConnections)
    .set({ status: 'revoked' })
    .where(and(eq(googleConnections.id, conn.id), eq(googleConnections.agencyId, conn.agencyId)));
  // Only the main Search Console/GA4 connection drives the client's "Reconnect needed" status;
  // other products show their own revoked state on their tab.
  if (conn.clientId && conn.purpose === 'client_data') {
    await db
      .update(clients)
      .set({ status: 'reconnect_needed', updatedAt: Date.now() })
      .where(and(eq(clients.id, conn.clientId), eq(clients.agencyId, conn.agencyId)));
  }
  await env.KV.delete(accessTokenKey(conn.id));
}

/** Disconnect: revoke at Google (best effort) and delete our copy. */
export async function deleteConnection(env: Env, conn: Connection) {
  try {
    const token = await decryptSecret(conn.encryptedRefreshToken, keyRingFromEnv(env));
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (err) {
    log.warn('Token revoke failed (ignored)', err);
  }
  await getDb(env)
    .delete(googleConnections)
    .where(and(eq(googleConnections.id, conn.id), eq(googleConnections.agencyId, conn.agencyId)));
  await env.KV.delete(accessTokenKey(conn.id));
}
