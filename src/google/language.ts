// Cloud Natural Language API (Phase 2): review sentiment + entities, one annotateText call per review.
// Auth: server-side API key restricted to the Natural Language API (needs billing on the project).
import { googleRequest } from './http';

export type SentimentLabel = 'positive' | 'neutral' | 'negative';
export type SentimentResult = {
  score: number; // -1..1
  magnitude: number; // 0..inf
  label: SentimentLabel;
  entities: { name: string; type: string; salience: number }[];
};

/** Thresholds commonly used with the NL API: |score| < 0.25 is treated as neutral/mixed. */
export function labelFor(score: number): SentimentLabel {
  if (score >= 0.25) return 'positive';
  if (score <= -0.25) return 'negative';
  return 'neutral';
}

type Raw = {
  documentSentiment?: { score?: number; magnitude?: number };
  entities?: { name?: string; type?: string; salience?: number }[];
};

export function parseAnnotation(data: Raw): SentimentResult {
  const score = data.documentSentiment?.score ?? 0;
  return {
    score,
    magnitude: data.documentSentiment?.magnitude ?? 0,
    label: labelFor(score),
    entities: (data.entities ?? [])
      .filter((e) => e.name && (e.salience ?? 0) >= 0.05)
      .slice(0, 8)
      .map((e) => ({
        name: e.name!.toLowerCase(),
        type: e.type ?? 'OTHER',
        salience: Math.round((e.salience ?? 0) * 100) / 100,
      })),
  };
}

export async function analyzeReviewText(apiKey: string, text: string): Promise<SentimentResult> {
  const data = await googleRequest<Raw>(
    `https://language.googleapis.com/v1/documents:annotateText?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      json: {
        document: { type: 'PLAIN_TEXT', content: text.slice(0, 5000) },
        features: { extractDocumentSentiment: true, extractEntities: true },
        encodingType: 'UTF8',
      },
      retries: 2,
    },
  );
  return parseAnnotation(data);
}

/** Pure: top themes (entities) across reviews of a given label, with counts. */
export function topThemes(
  rows: { label: SentimentLabel; entities: { name: string }[] }[],
  label: SentimentLabel,
  limit = 8,
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.label !== label) continue;
    for (const name of new Set(r.entities.map((e) => e.name)))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
