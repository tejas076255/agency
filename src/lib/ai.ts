import { z } from 'zod';
import type { Env } from '../env';

// ---------------------------------------------------------------------------------------------
// The ONLY place that talks to an AI model. To switch models/providers, change runModel().
// ---------------------------------------------------------------------------------------------

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type AiRunner = { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> };

export async function runModel(
  env: Pick<Env, 'AI' | 'AI_MODEL' | 'AI_GATEWAY_ID'>,
  messages: ChatMessage[],
  opts: { jsonSchema?: object; maxTokens?: number } = {},
): Promise<{ output: unknown; model: string }> {
  const ai = env.AI as unknown as AiRunner;
  const input = {
    messages,
    max_tokens: opts.maxTokens ?? 1500,
    temperature: 0.3,
    ...(opts.jsonSchema
      ? { response_format: { type: 'json_schema', json_schema: opts.jsonSchema } }
      : {}),
  };
  let result: unknown;
  try {
    // Routed through AI Gateway for logging, caching and rate limits.
    result = await ai.run(
      env.AI_MODEL,
      input,
      env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
    );
  } catch (err) {
    // If the gateway isn't set up yet, don't break insights: call the model directly.
    if (env.AI_GATEWAY_ID && /gateway/i.test(String((err as Error)?.message))) {
      console.warn('AI Gateway call failed, retrying without gateway:', (err as Error).message);
      result = await ai.run(env.AI_MODEL, input);
    } else {
      throw err;
    }
  }
  const output = (result as { response?: unknown })?.response ?? result;
  return { output, model: env.AI_MODEL };
}

// ---------------------------------------------------------------------------------------------
// Insights: compact JSON summary in -> plain-English summary + exactly 5 prioritized actions out.
// ---------------------------------------------------------------------------------------------

const actionItemSchema = z.object({
  priority: z.number().int().min(1).max(5),
  title: z.string().trim().min(3).max(160),
  why: z.string().trim().min(5).max(600),
  expected_impact: z.string().trim().min(3).max(300),
});

export const insightOutputSchema = z
  .object({
    summary: z.string().trim().min(20).max(1500),
    summary_hinglish: z.string().trim().min(20).max(1500).optional(),
    action_items: z.array(actionItemSchema).length(5, 'Expected exactly 5 action items'),
  })
  .refine((v) => new Set(v.action_items.map((a) => a.priority)).size === 5, {
    message: 'Priorities must be 1, 2, 3, 4 and 5 (each used once)',
    path: ['action_items'],
  });

export type InsightOutput = z.infer<typeof insightOutputSchema>;

/** JSON schema given to the model (Workers AI JSON mode). Zod still validates the result. */
export function insightJsonSchema(hinglish: boolean) {
  const item = {
    type: 'object',
    properties: {
      priority: { type: 'integer', minimum: 1, maximum: 5 },
      title: { type: 'string' },
      why: { type: 'string' },
      expected_impact: { type: 'string' },
    },
    required: ['priority', 'title', 'why', 'expected_impact'],
  };
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      ...(hinglish ? { summary_hinglish: { type: 'string' } } : {}),
      action_items: { type: 'array', items: item, minItems: 5, maxItems: 5 },
    },
    required: ['summary', 'action_items', ...(hinglish ? ['summary_hinglish'] : [])],
  };
}

/** Accepts an object or a string (possibly with text around the JSON) and validates it. */
export function parseInsightOutput(
  raw: unknown,
  opts: { requireHinglish?: boolean } = {},
): { ok: true; data: InsightOutput } | { ok: false; error: string } {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start)
      return { ok: false, error: 'Response did not contain a JSON object' };
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { ok: false, error: 'Response was not valid JSON' };
    }
  }
  const parsed = insightOutputSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  if (opts.requireHinglish && !parsed.data.summary_hinglish) {
    return { ok: false, error: 'summary_hinglish is required' };
  }
  const data = {
    ...parsed.data,
    action_items: [...parsed.data.action_items].sort((a, b) => a.priority - b.priority),
  };
  return { ok: true, data };
}

const SYSTEM_PROMPT = `You are a senior SEO and digital marketing consultant for small businesses in India.
You receive a compact JSON health check for ONE client website (Search Console, Google Analytics 4 and PageSpeed data; some sections may be missing).
Write for a busy agency owner. Be specific: mention real queries, pages and numbers from the data. Never invent data that is not in the JSON.
Return ONLY a JSON object with:
- "summary": 3-5 plain-English sentences on how the site did in the last 28 days vs the previous 28 days and the single biggest issue.
- "action_items": EXACTLY 5 items, each { "priority": 1-5 (1 = do first, each number used once), "title": short imperative task, "why": the data-backed reason, "expected_impact": realistic outcome (e.g. "+10-20% clicks on these 3 queries in 4-6 weeks") }.
Prefer quick wins (keywords at positions 8-20), fixing pages that lost clicks, and the top speed opportunities.`;

const HINGLISH_RULE = `
- "summary_hinglish": the same summary in simple Hinglish (Hindi written in Roman/English letters mixed with common English words), friendly tone.`;

export async function generateInsights(
  env: Pick<Env, 'AI' | 'AI_MODEL' | 'AI_GATEWAY_ID'>,
  compactSummary: object,
  opts: { hinglish?: boolean } = {},
): Promise<{ data: InsightOutput; model: string }> {
  const hinglish = opts.hinglish ?? true;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + (hinglish ? HINGLISH_RULE : '') },
    { role: 'user', content: JSON.stringify(compactSummary) },
  ];
  const schema = insightJsonSchema(hinglish);

  const first = await runModel(env, messages, { jsonSchema: schema });
  const p1 = parseInsightOutput(first.output, { requireHinglish: hinglish });
  if (p1.ok) return { data: p1.data, model: first.model };

  // Retry once, telling the model exactly what was wrong.
  const second = await runModel(
    env,
    [
      ...messages,
      {
        role: 'assistant',
        content: typeof first.output === 'string' ? first.output : JSON.stringify(first.output),
      },
      {
        role: 'user',
        content: `Your previous answer was invalid: ${p1.error}. Reply again with ONLY the corrected JSON object.`,
      },
    ],
    { jsonSchema: schema },
  );
  const p2 = parseInsightOutput(second.output, { requireHinglish: hinglish });
  if (p2.ok) return { data: p2.data, model: second.model };
  throw new Error(`AI returned invalid output twice: ${p2.error}`);
}
