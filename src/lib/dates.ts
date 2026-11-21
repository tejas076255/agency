// Date helpers. All "calendar" dates are computed in IST (Asia/Kolkata, UTC+5:30, no DST).

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for the given instant, in IST. */
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type DateRange = { start: string; end: string };

/**
 * Two back-to-back periods of `length` days. The current period ends `lagDays` before today (IST),
 * because Search Console data arrives ~2-3 days late and GA4's "today" is incomplete.
 */
export function comparePeriods(
  now: number,
  lagDays: number,
  length = 28,
): { current: DateRange; previous: DateRange } {
  const end = addDays(istDate(now), -lagDays);
  const start = addDays(end, -(length - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(length - 1));
  return { current: { start, end }, previous: { start: prevStart, end: prevEnd } };
}

/** "YYYY-MM" of the month in IST. */
export function istMonth(ms: number): string {
  return istDate(ms).slice(0, 7);
}

/** "YYYY-MM" of the previous month in IST (used by the monthly cron on the 1st). */
export function previousIstMonth(ms: number): string {
  const [y, m] = istMonth(ms).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** "November 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Percentage change, or null when it can't be computed (previous was 0 and current isn't). */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
