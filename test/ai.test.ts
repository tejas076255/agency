import { describe, expect, it } from 'vitest';
import { generateInsights, parseInsightOutput } from '../src/lib/ai';
import { validAiOutput } from './helpers';

describe('parseInsightOutput', () => {
  it('accepts a valid object and sorts action items by priority', () => {
    const shuffled = { ...validAiOutput, action_items: [...validAiOutput.action_items].reverse() };
    const r = parseInsightOutput(shuffled, { requireHinglish: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.action_items.map((a) => a.priority)).toEqual([1, 2, 3, 4, 5]);
  });

  it('extracts JSON wrapped in extra text (common LLM habit)', () => {
    const r = parseInsightOutput(
      'Sure! Here it is:\n```json\n' + JSON.stringify(validAiOutput) + '\n```',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects anything other than exactly 5 action items', () => {
    const four = { ...validAiOutput, action_items: validAiOutput.action_items.slice(0, 4) };
    const r = parseInsightOutput(four);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exactly 5/);
  });

  it('rejects duplicate priorities', () => {
    const dup = {
      ...validAiOutput,
      action_items: validAiOutput.action_items.map((a) => ({ ...a, priority: 1 })),
    };
    expect(parseInsightOutput(dup).ok).toBe(false);
  });

  it('rejects missing fields, non-JSON, and missing Hinglish when required', () => {
    const noWhy = {
      ...validAiOutput,
      action_items: validAiOutput.action_items.map(({ why: _why, ...rest }) => rest),
    };
    expect(parseInsightOutput(noWhy).ok).toBe(false);
    expect(parseInsightOutput('I cannot help with that').ok).toBe(false);
    expect(parseInsightOutput('{not json}').ok).toBe(false);
    const { summary_hinglish: _h, ...noHinglish } = validAiOutput;
    expect(parseInsightOutput(noHinglish, { requireHinglish: true }).ok).toBe(false);
    expect(parseInsightOutput(noHinglish, { requireHinglish: false }).ok).toBe(true);
  });
});

describe('generateInsights (retry once)', () => {
  const env = (responses: unknown[]) => {
    const calls: unknown[] = [];
    return {
      calls,
      env: {
        AI_MODEL: '@cf/test/model',
        AI_GATEWAY_ID: '',
        AI: {
          run: async (_m: string, input: unknown) => {
            calls.push(input);
            return { response: responses.shift() };
          },
        } as unknown as Ai,
      },
    };
  };

  it('returns on the first valid answer', async () => {
    const t = env([validAiOutput]);
    const r = await generateInsights(t.env, { x: 1 });
    expect(r.data.action_items).toHaveLength(5);
    expect(t.calls).toHaveLength(1);
  });

  it('retries once with the validation error, then succeeds', async () => {
    const t = env(['garbage', JSON.stringify(validAiOutput)]);
    const r = await generateInsights(t.env, { x: 1 });
    expect(r.data.summary).toContain('Clicks');
    expect(t.calls).toHaveLength(2);
    const retryMessages = (t.calls[1] as { messages: { content: string }[] }).messages;
    expect(retryMessages.at(-1)?.content).toMatch(/invalid/);
  });

  it('throws after two invalid answers', async () => {
    const t = env(['bad', 'still bad']);
    await expect(generateInsights(t.env, { x: 1 })).rejects.toThrow(/invalid output twice/);
    expect(t.calls).toHaveLength(2);
  });
});
