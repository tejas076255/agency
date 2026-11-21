import { z } from 'zod';
import type { Env } from '../env';
import {
  buildFallbackInsights,
  findUngroundedNumbers,
  type CompactSummary,
  type InsightResult,
} from './insights';
import { log } from './log';
import { recordApiCall } from './usage';

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
    max_tokens: opts.maxTokens ?? 2000,
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
    recordApiCall('workers_ai', { ok: true });
  } catch (err) {
    recordApiCall('workers_ai', { ok: false });
    // If the gateway isn't set up yet, don't break insights: call the model directly.
    if (env.AI_GATEWAY_ID && /gateway/i.test(String((err as Error)?.message))) {
      log.warn('AI Gateway call failed, retrying without gateway', err);
      result = await ai.run(env.AI_MODEL, input);
      recordApiCall('workers_ai', { ok: true });
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
  description: z.string().trim().min(10).max(600),
  why: z.string().trim().min(5).max(600),
  expected_impact: z.string().trim().min(3).max(300),
  supporting_metrics: z.array(z.string().trim().min(2).max(200)).min(1).max(4),
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

// Words that promise results (not allowed: the app must never guarantee outcomes).
const GUARANTEE_RE = /\b(guarantee[sd]?|guaranteed|100% sure|definitely will|assured)\b/i;

/** JSON schema given to the model (Workers AI JSON mode). Zod still validates the result. */
export function insightJsonSchema(hinglish: boolean) {
  const item = {
    type: 'object',
    properties: {
      priority: { type: 'integer', minimum: 1, maximum: 5 },
      title: { type: 'string' },
      description: { type: 'string' },
      why: { type: 'string' },
      expected_impact: { type: 'string' },
      supporting_metrics: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
    },
    required: ['priority', 'title', 'description', 'why', 'expected_impact', 'supporting_metrics'],
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

/**
 * Accepts an object or a string (possibly with text around the JSON) and validates it.
 * With `source`, also rejects supporting metrics that quote numbers not present in the data.
 */
export function parseInsightOutput(
  raw: unknown,
  opts: { requireHinglish?: boolean; source?: CompactSummary } = {},
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
  const allText = JSON.stringify(parsed.data);
  if (GUARANTEE_RE.test(allText)) {
    return { ok: false, error: 'Do not guarantee results; use words like "could" or "may"' };
  }
  if (opts.source) {
    const bad = findUngroundedNumbers(
      parsed.data.action_items.flatMap((a) => a.supporting_metrics),
      opts.source,
    );
    if (bad.length > 0) {
      return {
        ok: false,
        error: `supporting_metrics contain numbers that are not in the data: ${bad.slice(0, 5).join(', ')}`,
      };
    }
  }
  const data = {
    ...parsed.data,
    action_items: [...parsed.data.action_items].sort((a, b) => a.priority - b.priority),
  };
  return { ok: true, data };
}

const SYSTEM_PROMPT = `You are a senior SEO and digital marketing consultant for small businesses in India.
You receive a compact JSON health check for ONE client website (Search Console, Google Analytics 4 and PageSpeed data; some sections may be missing or null).
Write for a busy agency owner. Be specific: mention real queries, pages and numbers from the data.
STRICT RULES:
- Never invent metrics. Only quote numbers that appear in the JSON.
- Never guarantee results. Use "could", "may", "likely".
- If a section is missing, you may recommend connecting it, but don't guess its numbers.
Return ONLY a JSON object with:
- "summary": 3-5 plain-English sentences on how the site did in the last 28 days vs the previous 28 days and the single biggest issue.
- "action_items": EXACTLY 5 items, each:
  { "priority": 1-5 (1 = do first, each number used once),
    "title": short imperative task,
    "description": 1-2 sentences on what exactly to do,
    "why": the data-backed reason,
    "expected_impact": realistic, non-guaranteed outcome,
    "supporting_metrics": 1-4 short, human-readable strings quoting exact numbers from the JSON, written in plain words (NOT JSON field names), e.g. "\\"seo pune\\": position 11.4, 820 impressions" or "Mobile speed score: 38/100". Never include empty values like [] }.
Prefer quick wins (keywords at positions 8-20), fixing pages that lost clicks, and the top speed fixes.`;

const HINGLISH_RULE = `
- "summary_hinglish": the same summary in simple Hinglish (Hindi written in Roman/English letters mixed with common English words), friendly tone.`;

export type GeneratedInsights = {
  data: InsightResult;
  model: string;
  source: 'ai' | 'fallback';
  /** Why the fallback was used (for logs/UI), if it was. */
  fallbackReason?: string;
};

/**
 * Generates insights with the AI model: validate -> retry once with the error -> deterministic
 * rule-based fallback. Never throws because of the AI: there are always 5 action items.
 */
export async function generateInsights(
  env: Pick<Env, 'AI' | 'AI_MODEL' | 'AI_GATEWAY_ID'>,
  summary: CompactSummary,
  opts: { hinglish?: boolean } = {},
): Promise<GeneratedInsights> {
  const hinglish = opts.hinglish ?? true;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + (hinglish ? HINGLISH_RULE : '') },
    { role: 'user', content: JSON.stringify(summary) },
  ];
  const schema = insightJsonSchema(hinglish);
  const parseOpts = { requireHinglish: hinglish, source: summary };
  const fallback = (reason: string): GeneratedInsights => {
    log.warn('Using rule-based insights fallback', undefined, { reason });
    return {
      data: buildFallbackInsights(summary),
      model: 'rule-based-fallback',
      source: 'fallback',
      fallbackReason: reason,
    };
  };

  let first: { output: unknown; model: string };
  try {
    first = await runModel(env, messages, { jsonSchema: schema });
  } catch (err) {
    return fallback(`AI call failed: ${(err as Error).message}`);
  }
  const p1 = parseInsightOutput(first.output, parseOpts);
  if (p1.ok) return { data: p1.data, model: first.model, source: 'ai' };

  // Retry once, telling the model exactly what was wrong.
  let second: { output: unknown; model: string };
  try {
    second = await runModel(
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
  } catch (err) {
    return fallback(`AI retry failed: ${(err as Error).message}`);
  }
  const p2 = parseInsightOutput(second.output, parseOpts);
  if (p2.ok) return { data: p2.data, model: second.model, source: 'ai' };
  return fallback(`AI returned invalid output twice: ${p2.error}`);
}
