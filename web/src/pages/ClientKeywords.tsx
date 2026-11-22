// Keyword rank tracker tab: weekly Google positions (Search Console) for keywords the agency picks.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { TrendChart } from '../components/charts';
import { useConfirm } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { formatDay, formatNumber, relativeTime } from '../lib/format';
import type { KeywordsResponse, TrackedKeyword } from '../lib/types';

type Notify = (kind: 'success' | 'error' | 'info', text: string) => void;

function positionStyle(p: number | null): string {
  if (p === null) return 'bg-slate-100 text-slate-500';
  if (p <= 3) return 'bg-green-100 text-green-800';
  if (p <= 10) return 'bg-blue-100 text-blue-800';
  if (p <= 20) return 'bg-amber-100 text-amber-800';
  return 'bg-slate-100 text-slate-700';
}

function Position({ value }: { value: number | null }) {
  return (
    <span
      className={`inline-block min-w-12 rounded px-2 py-0.5 text-center text-xs font-semibold tabular-nums ${positionStyle(value)}`}
      title={value === null ? 'No impressions this week' : 'Average Google position this week'}
    >
      {value === null ? 'Not ranking' : value.toFixed(1)}
    </span>
  );
}

/** Positive = moved up in Google (smaller position number). */
function Movement({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-400">—</span>;
  if (Math.abs(value) < 0.1) return <span className="text-slate-500">no change</span>;
  const up = value > 0;
  return (
    <span className={`font-medium tabular-nums ${up ? 'text-green-700' : 'text-red-700'}`}>
      {up ? '▲' : '▼'} {Math.abs(value).toFixed(1)}
    </span>
  );
}

function shortPath(url: string | null): string {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

export function KeywordsTab({ clientId, notify }: { clientId: string; notify: Notify }) {
  const confirm = useConfirm();
  const [data, setData] = useState<KeywordsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<KeywordsResponse>(`/api/clients/${clientId}/keywords`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(keywords: string[]) {
    const list = keywords.map((k) => k.trim()).filter((k) => k.length >= 2);
    if (list.length === 0) return;
    setAdding(true);
    try {
      const r = await api<{ added: number; checked: number; warning: string | null }>(
        `/api/clients/${clientId}/keywords`,
        { method: 'POST', body: { keywords: list } },
      );
      setInput('');
      if (r.added === 0) notify('info', 'These keywords are already tracked.');
      else if (r.warning) notify('info', `Added ${r.added} keyword(s). ${r.warning}`);
      else
        notify(
          'success',
          `Added ${r.added} keyword(s) with ${r.checked ? '13 weeks of' : 'no'} history.`,
        );
      await load();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function checkNow() {
    setChecking(true);
    try {
      const r = await api<{ checked: number; failed: { keyword: string; error: string }[] }>(
        `/api/clients/${clientId}/keywords/check`,
        { method: 'POST', body: {} },
      );
      notify(
        r.failed.length ? 'info' : 'success',
        r.failed.length
          ? `Checked ${r.checked}, ${r.failed.length} failed: ${r.failed[0]!.error}`
          : `Updated ${r.checked} keyword(s) from Search Console.`,
      );
      await load();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function remove(k: TrackedKeyword) {
    const ok = await confirm({
      title: `Stop tracking “${k.keyword}”?`,
      message: 'Its ranking history is deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/clients/${clientId}/keywords/${k.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Skeleton className="h-64" />;

  const ks = data.keywords;
  const ranked = ks.filter((k) => k.latest?.position != null);
  const stats = [
    { label: 'Tracked', value: `${ks.length} / ${data.limit}` },
    { label: 'In top 3', value: String(ranked.filter((k) => k.latest!.position! <= 3).length) },
    {
      label: 'On page 1 (top 10)',
      value: String(ranked.filter((k) => k.latest!.position! <= 10).length),
    },
    {
      label: 'Moved up / down (week)',
      value: `${ks.filter((k) => (k.change ?? 0) >= 0.1).length} / ${ks.filter((k) => (k.change ?? 0) <= -0.1).length}`,
    },
  ];
  const lastChecked = Math.max(0, ...ks.map((k) => k.lastCheckedAt ?? 0));
  const room = data.limit - ks.length;

  return (
    <div className="space-y-6">
      {data.notReady && <Alert kind="info">{data.notReady}</Alert>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">Keyword rank tracker</h3>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              Average Google position per week from Search Console (1 = top of Google). Updated
              automatically with every weekly health check. Last update:{' '}
              {relativeTime(lastChecked || null)}.
            </p>
          </div>
          <Button
            variant="secondary"
            loading={checking}
            disabled={ks.length === 0 || Boolean(data.notReady)}
            onClick={checkNow}
          >
            Check now
          </Button>
        </div>

        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void add(input.split(/[,\n]/));
          }}
        >
          <input
            className={inputClass}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. seo agency in pune, digital marketing pune"
            aria-label="Keywords to track (comma separated)"
            maxLength={2000}
          />
          <Button type="submit" loading={adding} disabled={room <= 0 || input.trim().length < 2}>
            Track
          </Button>
        </form>
        <p className="mt-1 text-xs text-slate-400">
          Separate several keywords with commas. Search Console only knows searches where the site
          appeared, so a brand-new keyword may show “Not ranking”.
        </p>

        {data.suggestions.length > 0 && room > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Suggestions from Search Console</h4>
              <button
                className="text-xs text-[var(--brand)] hover:underline"
                disabled={adding}
                onClick={() => add(data.suggestions.slice(0, room).map((s) => s.keyword))}
              >
                Track {Math.min(room, data.suggestions.length)} suggestions
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.suggestions.map((s) => (
                <button
                  key={s.keyword}
                  disabled={adding}
                  onClick={() => add([s.keyword])}
                  className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-700 hover:border-[var(--brand)] hover:text-[var(--brand)]"
                  title={`${formatNumber(s.impressions)} impressions in 28 days`}
                >
                  + {s.keyword} <span className="text-slate-400">· pos {s.position}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {ks.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {stats.map((s) => (
              <Card key={s.label} className="p-4">
                <div className="text-xs text-slate-500">{s.label}</div>
                <div className="mt-1 text-xl font-bold tabular-nums">{s.value}</div>
              </Card>
            ))}
          </div>

          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-2 font-medium">Keyword</th>
                  <th className="px-3 py-2 font-medium">Position</th>
                  <th className="px-3 py-2 font-medium">vs last week</th>
                  <th className="px-3 py-2 font-medium">13 weeks</th>
                  <th className="px-3 py-2 font-medium">Best</th>
                  <th className="px-3 py-2 text-right font-medium">Clicks</th>
                  <th className="px-3 py-2 text-right font-medium">Impr.</th>
                  <th className="px-3 py-2 font-medium">Ranking page</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {ks.map((k) => (
                  <Fragment key={k.id}>
                    <tr className="border-b border-slate-100 align-middle">
                      <td className="px-4 py-2">
                        <button
                          className="text-left font-medium hover:text-[var(--brand)]"
                          onClick={() => setOpen(open === k.id ? null : k.id)}
                          aria-expanded={open === k.id}
                        >
                          {k.keyword}
                        </button>
                        {k.lastError && (
                          <div className="text-xs text-red-600" title={k.lastError}>
                            ⚠ last check failed
                          </div>
                        )}
                        {!k.lastCheckedAt && !k.lastError && (
                          <div className="text-xs text-slate-400">waiting for first check</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Position value={k.latest?.position ?? null} />
                      </td>
                      <td className="px-3 py-2">
                        <Movement value={k.change} />
                      </td>
                      <td className="px-3 py-2">
                        <Movement value={k.changeAll} />
                      </td>
                      <td className="px-3 py-2 tabular-nums">{k.best?.toFixed(1) ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatNumber(k.latest?.clicks ?? null)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatNumber(k.latest?.impressions ?? null)}
                      </td>
                      <td className="max-w-[14rem] truncate px-3 py-2 text-xs text-slate-500">
                        {k.latest?.topPage ? (
                          <a
                            href={k.latest.topPage}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                            title={k.latest.topPage}
                          >
                            {shortPath(k.latest.topPage)}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button
                          className="mr-3 text-xs text-[var(--brand)] hover:underline"
                          onClick={() => setOpen(open === k.id ? null : k.id)}
                        >
                          {open === k.id ? 'Hide' : 'Graph'}
                        </button>
                        <button
                          className="text-xs text-red-600 hover:underline"
                          onClick={() => remove(k)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    {open === k.id && (
                      <tr className="border-b border-slate-100 bg-slate-50/50">
                        <td colSpan={9} className="px-4 py-3">
                          <div className="mb-1 text-xs text-slate-500">
                            Weekly average position for “{k.keyword}” (higher on the chart = better)
                          </div>
                          <TrendChart
                            data={k.history.map((h) => ({ ...h }))}
                            xKey="periodEnd"
                            yKey="position"
                            name="Position"
                            formatX={(v) => formatDay(String(v))}
                            formatY={(v) => (v ? v.toFixed(1) : 'not ranking')}
                            reversed
                            height={200}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-slate-400">
            Position is Search Console’s impression-weighted average for the week (Sunday–Saturday),
            so it can differ from a single manual search. “Not ranking” means the site got no
            impressions for that keyword that week.
          </p>
        </>
      )}
    </div>
  );
}
