// Display helpers: all times in IST, numbers in Indian grouping (1,23,456).

const IST = 'Asia/Kolkata';

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return (
    new Date(ms).toLocaleString('en-IN', {
      timeZone: IST,
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' IST'
  );
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'short',
  });
}

/** "2026-11-03" -> "3 Nov" */
export function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
}

export function formatMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Math.round(n).toLocaleString('en-IN');
}

export function formatInr(n: number): string {
  return n.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  });
}

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
