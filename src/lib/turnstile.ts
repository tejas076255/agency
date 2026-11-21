/** Verifies a Cloudflare Turnstile token server-side. Fails closed. */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  ip: string | undefined,
): Promise<boolean> {
  if (!secret || !token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification failed', err);
    return false;
  }
}
