// Score and status indicators. Status always pairs color with an icon + label (never color alone).

export function ScoreBadge({ score, size = 'md' }: { score: number | null; size?: 'md' | 'lg' }) {
  const tone =
    score === null
      ? 'bg-slate-100 text-slate-500'
      : score >= 75
        ? 'bg-green-50 text-green-700 ring-green-200'
        : score >= 50
          ? 'bg-amber-50 text-amber-700 ring-amber-200'
          : 'bg-red-50 text-red-700 ring-red-200';
  const dims = size === 'lg' ? 'h-20 w-20 text-3xl' : 'h-11 w-11 text-base';
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ring-1 ${tone} ${dims}`}
      title={score === null ? 'No score yet' : `Health score ${score}/100`}
    >
      {score ?? '—'}
    </div>
  );
}

export function TrendArrow({
  current,
  previous,
}: {
  current: number | null;
  previous: number | null;
}) {
  if (current === null || previous === null)
    return <span className="text-xs text-slate-400">—</span>;
  const diff = current - previous;
  if (diff === 0)
    return (
      <span className="text-xs text-slate-500" title="No change">
        → 0
      </span>
    );
  return diff > 0 ? (
    <span className="text-xs font-medium text-green-700" title={`Up ${diff} points`}>
      ▲ {diff}
    </span>
  ) : (
    <span className="text-xs font-medium text-red-700" title={`Down ${-diff} points`}>
      ▼ {-diff}
    </span>
  );
}

export function ChangePill({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined)
    return <span className="text-xs text-slate-400">no earlier data</span>;
  const up = pct >= 0;
  return (
    <span className={`text-xs font-medium ${up ? 'text-green-700' : 'text-red-700'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%{' '}
      <span className="font-normal text-slate-500">vs prev. 28 days</span>
    </span>
  );
}

const CLIENT_STATUS = {
  active: { label: 'Connected', icon: '●', cls: 'bg-green-50 text-green-700' },
  not_connected: { label: 'Not connected', icon: '○', cls: 'bg-slate-100 text-slate-600' },
  reconnect_needed: { label: 'Reconnect needed', icon: '⚠', cls: 'bg-red-50 text-red-700' },
} as const;

export function ClientStatusBadge({ status }: { status: keyof typeof CLIENT_STATUS }) {
  const s = CLIENT_STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}
    >
      <span aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}

const JOB_STATUS: Record<string, { label: string; icon: string; cls: string }> = {
  queued: { label: 'Queued', icon: '⏳', cls: 'bg-slate-100 text-slate-600' },
  running: { label: 'Running', icon: '⟳', cls: 'bg-blue-50 text-blue-700' },
  success: { label: 'Success', icon: '✓', cls: 'bg-green-50 text-green-700' },
  partial: { label: 'Partial', icon: '◐', cls: 'bg-amber-50 text-amber-700' },
  failed: { label: 'Failed', icon: '✕', cls: 'bg-red-50 text-red-700' },
  generating: { label: 'Generating', icon: '⟳', cls: 'bg-blue-50 text-blue-700' },
  ready: { label: 'Ready to send', icon: '✓', cls: 'bg-amber-50 text-amber-700' },
  sent: { label: 'Sent', icon: '✉', cls: 'bg-green-50 text-green-700' },
  ok: { label: 'Complete', icon: '✓', cls: 'bg-green-50 text-green-700' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = JOB_STATUS[status] ?? { label: status, icon: '•', cls: 'bg-slate-100 text-slate-600' };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}
    >
      <span aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}
