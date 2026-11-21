// Tiny fetch wrapper: JSON in/out, CSRF header on state-changing requests, readable errors.

export type Agency = {
  id: string;
  name: string;
  brandColor: string;
  plan: string;
  logoUrl: string | null;
};

export type Me = {
  user: {
    id: string;
    email: string;
    name: string;
    pictureUrl: string | null;
    role: 'owner' | 'member';
  } | null;
  agency: Agency | null;
  csrfToken: string | null;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type Options = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
};

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}
