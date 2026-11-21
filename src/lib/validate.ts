import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

/** Parses and validates a JSON request body. Throws a 400 HTTPException if invalid. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new HTTPException(400, { message: formatIssues(result.error) });
  return result.data;
}
