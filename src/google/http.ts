// One place for calling Google REST APIs: auth header, JSON, retries with exponential backoff,
// and per-agency usage counting (quota monitoring).
import { redactString } from '../lib/log';
import { apiNameFromUrl, recordApiCall } from '../lib/usage';

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
    /** Request method + URL with secrets (API keys, tokens) redacted. */
    public readonly endpoint?: string,
    /** Raw error response body from Google (truncated, secrets redacted). */
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
  /** Worth retrying later (quota / Google-side problems). */
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** The stored refresh token no longer works: the user must reconnect their Google account. */
export class ReconnectNeededError extends Error {
  constructor(message = 'Google access was revoked. Please reconnect the Google account.') {
    super(message);
    this.name = 'ReconnectNeededError';
  }
}

/** Tests set baseDelayMs to 1 so retries don't slow the suite. */
export const retryConfig = { baseDelayMs: 500, maxRetries: 4 };

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  accessToken?: string;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as-is (use with contentType). */
  body?: BodyInit;
  contentType?: string;
  responseType?: 'json' | 'bytes';
  timeoutMs?: number;
  retries?: number;
  /** Extra headers (e.g. Places field mask, Ads login-customer-id). */
  headers?: Record<string, string>;
};

export async function googleRequest<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const retries = opts.retries ?? retryConfig.maxRetries;
  const api = apiNameFromUrl(url);
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
      let body = opts.body;
      if (opts.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.contentType) {
        headers['Content-Type'] = opts.contentType;
      }
      res = await fetch(url, {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      // Network error or timeout.
      recordApiCall(api, { ok: false });
      if (attempt < retries) {
        await sleep(backoff(attempt++));
        continue;
      }
      throw new GoogleApiError(
        503,
        'network',
        `Could not reach Google: ${redactString((err as Error).message)}`,
      );
    }

    recordApiCall(api, { ok: res.ok, status: res.status });
    if (res.ok) {
      if (opts.responseType === 'bytes') return new Uint8Array(await res.arrayBuffer()) as T;
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }

    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10_000)
          : backoff(attempt);
      attempt++;
      await sleep(wait);
      continue;
    }

    const rawBody = await res.text().catch(() => '');
    let data: {
      error?:
        | {
            message?: string;
            status?: string;
            errors?: { reason?: string }[];
            details?: { reason?: string }[];
          }
        | string;
      error_description?: string;
    } = {};
    try {
      data = JSON.parse(rawBody);
    } catch {
      // non-JSON error body
    }
    const e = data.error;
    const message =
      typeof e === 'object'
        ? (e.message ?? `HTTP ${res.status}`)
        : (data.error_description ?? e ?? `HTTP ${res.status}`);
    const reason =
      typeof e === 'object'
        ? (e.details?.find((d) => d.reason)?.reason ?? e.errors?.[0]?.reason ?? e.status ?? 'error')
        : (e ?? 'error');
    const method = opts.method ?? (opts.body || opts.json !== undefined ? 'POST' : 'GET');
    throw new GoogleApiError(
      res.status,
      reason,
      message,
      redactString(`${method} ${url}`),
      redactString(rawBody.slice(0, 2000)),
    );
  }
}

function backoff(attempt: number): number {
  const base = retryConfig.baseDelayMs * 2 ** attempt;
  return base + Math.random() * base * 0.3; // jitter
}

/** Short human-readable message for job logs and the UI. */
export function describeError(err: unknown): string {
  if (err instanceof ReconnectNeededError) return 'Reconnect needed: Google access was revoked';
  if (err instanceof GoogleApiError) {
    if (err.status === 403) return `Permission denied by Google: ${err.message}`;
    if (err.status === 429) return 'Google API quota exceeded, will retry later';
    return `Google API error (${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
