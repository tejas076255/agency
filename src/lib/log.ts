// Secret-safe logging. Everything that goes to console passes through redact(), so OAuth tokens,
// API keys, client secrets and encrypted blobs never end up in Cloudflare logs.

const SECRET_KEY_RE =
  /token|secret|password|authorization|api[_-]?key|cookie|code_verifier|credential|refresh/i;

const SECRET_VALUE_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/ya29\.[A-Za-z0-9._-]+/g, 'ya29.[REDACTED]'], // Google access tokens
  [/1\/\/[A-Za-z0-9._-]{10,}/g, '1//[REDACTED]'], // Google refresh tokens
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]'], // Google API keys
  [/GOCSPX-[A-Za-z0-9_-]+/g, 'GOCSPX-[REDACTED]'], // OAuth client secrets
  [/([?&](?:key|access_token|refresh_token|token|code|client_secret)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/v2\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9+/=]{12,}\.[A-Za-z0-9+/=]{12,}/g, '[ENCRYPTED]'],
  [/v1\.[A-Za-z0-9+/=]{12,}\.[A-Za-z0-9+/=]{12,}/g, '[ENCRYPTED]'],
];

export function redactString(s: string): string {
  return SECRET_VALUE_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

/** Deep-redacts secrets from any value (objects, arrays, errors, strings). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[...]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack.split('\n').slice(0, 6).join('\n')) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Ctx = Record<string, unknown>;

export const log = {
  info(message: string, ctx?: Ctx) {
    console.log(redactString(message), ...(ctx ? [redact(ctx)] : []));
  },
  warn(message: string, err?: unknown, ctx?: Ctx) {
    console.warn(redactString(message), ...(err !== undefined ? [redact(err)] : []), ...(ctx ? [redact(ctx)] : []));
  },
  error(message: string, err?: unknown, ctx?: Ctx) {
    console.error(redactString(message), ...(err !== undefined ? [redact(err)] : []), ...(ctx ? [redact(ctx)] : []));
  },
};
