import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChangePill, ClientStatusBadge, ScoreBadge, StatusBadge } from '../components/badges';
import { TrendChart } from '../components/charts';
import { AdsTab, ExportsTab, LocalSeoTab, useIntegrations, YouTubeTab } from './ClientChannels';
import { KeywordsTab } from './ClientKeywords';
import { AiTab } from './ClientAi';
import { GbpEditorTab } from './ClientGbpEditor';
import { useConfirm } from '../components/ConfirmDialog';
import { DetailSkeleton, Skeleton } from '../components/Skeleton';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatDay, formatMonth, formatNumber } from '../lib/format';
import type {
  ActionItem,
  ClientDetail,
  GoogleOptions,
  ScoreBreakdown,
  SpeedResult,
} from '../lib/types';

type Notice = { kind: 'success' | 'error' | 'info'; text: string };

const CONNECT_ERRORS: Record<string, string> = {
  missing_scopes: 'Please allow access to Search Console and/or Analytics on the Google screen.',
  no_refresh_token: 'Google did not give long-term access. Please try connecting again.',
  google_error: 'Google connection failed. Please try again.',
};

const SOURCE_LABEL: Record<string, string> = {
  gsc: 'Search Console',
  ga4: 'Analytics',
  pagespeed: 'PageSpeed',
  ai: 'AI insights',
  keywords: 'Keyword tracker',
};

export function ClientDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<ClientDetail>(`/api/clients/${id}`));
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404 ? 'Client not found' : (e as Error).message,
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Messages after returning from Google.
  useEffect(() => {
    const connected = params.get('connected');
    if (connected && connected !== '1' && connected !== 'data') {
      setTab(connected === 'gbp' ? 'local' : (connected as Tab));
      setNotice({
        kind: 'success',
        text: 'Google account connected. Now choose what to track below.',
      });
    } else if (connected)
      setNotice({
        kind: 'success',
        text: 'Google account connected. Now pick the Search Console site and GA4 property.',
      });
    const tabParam = params.get('tab');
    if (tabParam) setTab(tabParam === 'gbp' ? 'local' : (tabParam as Tab));
    const err = params.get('connect_error');
    if (err) setNotice({ kind: 'error', text: CONNECT_ERRORS[err] ?? 'Google connection failed.' });
    if (params.get('connected') || err || tabParam) setParams({}, { replace: true });
  }, [params, setParams]);

  // While a job is running, refresh every 5 seconds.
  const pending =
    data?.pending.healthCheck ||
    data?.pending.report ||
    data?.reports.some((r) => r.status === 'generating');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [pending, load]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <DetailSkeleton />;

  const { client, latestCheck: check, insight } = data;
  const gsc = check?.gsc ?? null;
  const ga4 = check?.ga4 ?? null;
  const mobile = check?.pagespeed?.mobile ?? null;
  const desktop = check?.pagespeed?.desktop ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/clients" className="text-sm text-slate-500 hover:text-slate-800">
            ← Clients
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold">{client.name}</h1>
            <ClientStatusBadge status={client.status} />
          </div>
          <a
            href={client.websiteUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-slate-500 hover:underline"
          >
            {client.websiteUrl}
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/clients/${client.id}/edit`}>
            <Button variant="secondary">Edit</Button>
          </Link>
          <RunButton
            clientId={client.id}
            pending={data.pending.healthCheck}
            onDone={load}
            onError={(t) => setNotice({ kind: 'error', text: t })}
          />
        </div>
      </div>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      <ClientTabs tab={tab} onChange={setTab} />
      {tab === 'keywords' && (
        <KeywordsTab clientId={client.id} notify={(kind, text) => setNotice({ kind, text })} />
      )}
      {tab === 'ai' && (
        <AiTab clientId={client.id} notify={(kind, text) => setNotice({ kind, text })} />
      )}
      {tab === 'profile' && (
        <GbpEditorTab clientId={client.id} notify={(kind, text) => setNotice({ kind, text })} />
      )}
      {tab !== 'overview' && tab !== 'keywords' && tab !== 'ai' && tab !== 'profile' && (
        <ChannelPanel
          tab={tab}
          clientId={client.id}
          notify={(kind, text) => setNotice({ kind, text })}
        />
      )}

      <div className={tab === 'overview' ? 'space-y-6' : 'hidden'}>
        <ConnectionCard data={data} onChange={load} onNotice={setNotice} />

        {data.pending.healthCheck && (
          <Alert kind="info">
            ⟳ Health check is running. This page updates automatically (usually 1-2 minutes).
          </Alert>
        )}

        {!check && !data.pending.healthCheck && (
          <Card className="py-10 text-center">
            <h2 className="font-semibold">No health check yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
              Run the first check now. Speed works right away; Search Console and Analytics need the
              Google account connected.
            </p>
          </Card>
        )}

        {check && (
          <>
            <Card>
              <div className="flex flex-wrap items-center gap-5">
                <ScoreBadge score={check.score} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">Health score</h2>
                    <StatusBadge status={check.status} />
                    <span className="text-xs text-slate-400">formula v{check.formulaVersion}</span>
                  </div>
                  <p className="text-sm text-slate-500">
                    Last checked {formatDateTime(check.runAt)} · last 28 days vs previous 28 days
                  </p>
                  {check.breakdown && <Breakdown b={check.breakdown} />}
                </div>
              </div>
              {Object.keys(check.errors).length > 0 && (
                <ul className="mt-4 space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  {Object.entries(check.errors).map(([k, v]) => (
                    <li key={k}>
                      ⚠ <b>{SOURCE_LABEL[k] ?? k}:</b> {v}
                    </li>
                  ))}
                </ul>
              )}
              {gsc && gsc.totals.current.impressions === 0 && (
                <p className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                  ℹ Search Console returned <b>no data</b> for <b>{client.gscSiteUrl}</b> in the
                  last 28 days. If the site gets Google traffic, the wrong property may be selected:
                  a property starting with <b>http://</b> does not include <b>https://</b> pages.
                  Prefer a Domain property (<b>sc-domain:</b>) or the exact https:// address, then
                  click Change above.
                </p>
              )}
            </Card>

            <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi
                label="Search clicks"
                value={formatNumber(gsc?.totals.current.clicks)}
                sub={gsc && <ChangePill pct={gsc.clicksChangePct} />}
              />
              <Kpi
                label="Impressions"
                value={formatNumber(gsc?.totals.current.impressions)}
                sub={gsc && <ChangePill pct={gsc.impressionsChangePct} />}
              />
              <Kpi
                label="Avg. Google position"
                value={gsc ? gsc.totals.current.position.toFixed(1) : '—'}
                sub={
                  gsc && (
                    <span className="text-xs text-slate-500">
                      CTR {(gsc.totals.current.ctr * 100).toFixed(1)}%
                    </span>
                  )
                }
              />
              <Kpi
                label="Organic sessions"
                value={formatNumber(ga4?.organicSessions?.current ?? null)}
                sub={ga4?.organicSessions && <ChangePill pct={ga4.organicSessions.changePct} />}
              />
              <Kpi
                label="All sessions"
                value={formatNumber(ga4?.totals.current.sessions)}
                sub={ga4 && <ChangePill pct={ga4.sessionsChangePct} />}
              />
              <Kpi
                label="Users / new users"
                value={
                  ga4
                    ? `${formatNumber(ga4.totals.current.users)} / ${formatNumber(ga4.totals.current.newUsers ?? null)}`
                    : '—'
                }
                sub={ga4 && <ChangePill pct={ga4.usersChangePct} />}
              />
              <Kpi
                label="Key events (leads)"
                value={formatNumber(ga4?.totals.current.keyEvents)}
                sub={ga4 && <ChangePill pct={ga4.keyEventsChangePct} />}
              />
              <Kpi
                label="Engagement rate"
                value={ga4 ? `${ga4.totals.current.engagementRate}%` : '—'}
              />
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <SpeedCard label="Mobile" s={mobile} />
              <SpeedCard label="Desktop" s={desktop} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <h3 className="mb-3 text-sm font-semibold">Daily search clicks</h3>
                <TrendChart
                  data={gsc?.dailyClicks ?? []}
                  xKey="date"
                  yKey="clicks"
                  name="Clicks"
                  formatX={(v) => formatDay(String(v))}
                />
              </Card>
              <Card>
                <h3 className="mb-3 text-sm font-semibold">Daily sessions</h3>
                <TrendChart
                  data={ga4?.dailySessions ?? []}
                  xKey="date"
                  yKey="sessions"
                  name="Sessions"
                  formatX={(v) => formatDay(String(v))}
                />
              </Card>
              <Card>
                <h3 className="mb-3 text-sm font-semibold">Mobile speed score over time</h3>
                <TrendChart
                  data={data.history.filter((h) => h.mobileSpeed !== null)}
                  xKey="runAt"
                  yKey="mobileSpeed"
                  name="Mobile speed"
                  formatX={(v) => formatDate(Number(v))}
                  yDomain={[0, 100]}
                />
              </Card>
            </div>
          </>
        )}

        {insight && <InsightCard insight={insight} />}
        {!insight && check && !data.pending.healthCheck && (
          <Alert kind="info">
            Action items will appear here after a health check with data.{' '}
            {check.errors.ai && `(${check.errors.ai})`}
          </Alert>
        )}

        {check && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="font-semibold">Quick-win keywords</h3>
              <p className="mb-3 text-xs text-slate-500">
                Ranking at positions 8-20: a small push can move them to page 1.
              </p>
              <Table
                empty={gsc ? 'No quick wins found' : 'Search Console not connected'}
                head={['Keyword', 'Impressions', 'Position']}
                rows={(gsc?.quickWins ?? []).map((q) => [
                  q.query,
                  formatNumber(q.impressions),
                  q.position.toFixed(1),
                ])}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Pages losing clicks</h3>
              <p className="mb-3 text-xs text-slate-500">Biggest drop vs the previous 28 days.</p>
              <Table
                empty={gsc ? 'No pages lost clicks 🎉' : 'Search Console not connected'}
                head={['Page', 'Before', 'Now']}
                rows={(gsc?.droppingPages ?? []).map((p) => [
                  shortUrl(p.page),
                  formatNumber(p.clicksBefore),
                  formatNumber(p.clicksNow),
                ])}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Top search queries</h3>
              <Table
                empty={gsc ? 'No queries yet' : 'Search Console not connected'}
                head={['Query', 'Clicks', 'Position']}
                rows={(gsc?.topQueries ?? [])
                  .slice(0, 8)
                  .map((q) => [q.query, formatNumber(q.clicks), q.position.toFixed(1)])}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Top pages (search)</h3>
              <Table
                empty={gsc ? 'No pages yet' : 'Search Console not connected'}
                head={['Page', 'Clicks', 'Position']}
                rows={(gsc?.topPages ?? [])
                  .slice(0, 8)
                  .map((p) => [shortUrl(p.page), formatNumber(p.clicks), p.position.toFixed(1)])}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Top traffic channels</h3>
              <Table
                empty={ga4 ? 'No channel data' : 'Analytics not connected'}
                head={['Channel', 'Sessions']}
                rows={(ga4?.topChannels ?? []).map((c) => [c.channel, formatNumber(c.sessions)])}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Top landing pages</h3>
              <Table
                empty={ga4 ? 'No landing page data' : 'Analytics not connected'}
                head={['Page', 'Sessions', 'Key events']}
                rows={(ga4?.topLandingPages ?? []).map((p) => [
                  p.page,
                  formatNumber(p.sessions),
                  formatNumber(p.keyEvents),
                ])}
              />
            </Card>
          </div>
        )}

        <ReportsCard data={data} onChange={load} onNotice={setNotice} />
      </div>
    </div>
  );
}

type Tab = 'overview' | 'keywords' | 'ai' | 'profile' | 'local' | 'ads' | 'youtube' | 'exports';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'ai', label: '✨ AI tools' },
  { id: 'profile', label: 'Google profile' },
  { id: 'local', label: 'Local SEO & reviews' },
  { id: 'ads', label: 'Google Ads' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'exports', label: 'Exports' },
];

function ClientTabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Client sections"
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
            tab === t.id
              ? 'border-[var(--brand)] text-[var(--brand)]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ChannelPanel({
  tab,
  clientId,
  notify,
}: {
  tab: Exclude<Tab, 'overview' | 'keywords' | 'ai' | 'profile'>;
  clientId: string;
  notify: (kind: Notice['kind'], text: string) => void;
}) {
  const { data, error, reload } = useIntegrations(clientId);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <DetailSkeleton />;
  const props = { clientId, data, reload, notify };
  if (tab === 'local') return <LocalSeoTab {...props} />;
  if (tab === 'ads') return <AdsTab {...props} />;
  if (tab === 'youtube') return <YouTubeTab {...props} />;
  return <ExportsTab {...props} />;
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.pathname + x.search || '/';
  } catch {
    return u;
  }
}

const SECTION_LABEL: Record<string, string> = {
  search: 'Search',
  traffic: 'Traffic',
  performance: 'Performance',
  completeness: 'Data completeness',
  seo: 'SEO',
  speed: 'Speed',
};

function Breakdown({ b }: { b: ScoreBreakdown }) {
  const keys = Object.keys(b).filter((k) => k in SECTION_LABEL);
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {keys.map((k) => {
        const s = b[k as keyof ScoreBreakdown];
        return (
          <span key={k} className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
            {SECTION_LABEL[k]}: {s ? `${s.points}/${s.max}` : 'no data'}
          </span>
        );
      })}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold">{value}</div>
      <div className="mt-1 min-h-4">{sub}</div>
    </Card>
  );
}

const sec = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;

/** Lab (simulated Lighthouse test) and field (real Chrome users) shown separately. */
function SpeedCard({ label, s }: { label: string; s: SpeedResult | null }) {
  if (!s) {
    return (
      <Card>
        <h3 className="font-semibold">{label} speed</h3>
        <p className="py-4 text-sm text-slate-400">No speed data.</p>
      </Card>
    );
  }
  const lab = s.lab ?? { lcpMs: s.lcpMs, cls: s.cls, tbtMs: s.tbtMs, fcpMs: null };
  const field = s.field ?? null;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{label} speed</h3>
        <ScoreBadge score={s.score} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs font-medium text-slate-500">Lab test (Lighthouse, right now)</div>
          <dl className="mt-1 grid grid-cols-2 gap-x-2 text-sm">
            <dt className="text-slate-500">LCP</dt>
            <dd className="text-right tabular-nums">{sec(lab.lcpMs)}</dd>
            <dt className="text-slate-500">CLS</dt>
            <dd className="text-right tabular-nums">{lab.cls ?? '—'}</dd>
            <dt className="text-slate-500">TBT</dt>
            <dd className="text-right tabular-nums">
              {lab.tbtMs === null ? '—' : `${lab.tbtMs} ms`}
            </dd>
          </dl>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs font-medium text-slate-500">
            Real users (last 28 days{field?.source === 'origin' ? ', whole site' : ''})
          </div>
          {field ? (
            <>
              <dl className="mt-1 grid grid-cols-2 gap-x-2 text-sm">
                <dt className="text-slate-500">LCP</dt>
                <dd className="text-right tabular-nums">{sec(field.lcpMs)}</dd>
                <dt className="text-slate-500">INP</dt>
                <dd className="text-right tabular-nums">
                  {field.inpMs === null ? '—' : `${field.inpMs} ms`}
                </dd>
                <dt className="text-slate-500">CLS</dt>
                <dd className="text-right tabular-nums">{field.cls ?? '—'}</dd>
              </dl>
              <div className="mt-2 text-xs font-medium">
                {field.cwvPassed === null ? (
                  <span className="text-slate-500">Core Web Vitals: not enough data</span>
                ) : field.cwvPassed ? (
                  <span className="text-green-700">✓ Core Web Vitals passed</span>
                ) : (
                  <span className="text-red-700">✕ Core Web Vitals failed</span>
                )}
              </div>
            </>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Google has no real-user data for this site yet (needs more Chrome traffic).
            </p>
          )}
        </div>
      </div>
      {s.opportunities.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-slate-500">Top fixes</div>
          <ul className="mt-1 space-y-1 text-sm">
            {s.opportunities.map((o) => (
              <li key={o.title} className="flex justify-between gap-3">
                <span className="truncate" title={o.title}>
                  {o.title}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  ~{(o.savingsMs / 1000).toFixed(1)} s
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: (string | number)[][];
  empty: string;
}) {
  if (rows.length === 0) return <p className="py-4 text-center text-sm text-slate-400">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
            {head.map((h, i) => (
              <th key={h} scope="col" className={`py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`py-2 ${j > 0 ? 'whitespace-nowrap pl-3 text-right tabular-nums' : 'max-w-[16rem] truncate'}`}
                  title={String(cell)}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunButton({
  clientId,
  pending,
  onDone,
  onError,
}: {
  clientId: string;
  pending: boolean;
  onDone: () => void;
  onError: (t: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      loading={busy || pending}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/api/clients/${clientId}/run`, {
            method: 'POST',
            body: { type: 'health_check' },
          });
          onDone();
        } catch (e) {
          onError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {pending ? 'Checking…' : 'Run health check'}
    </Button>
  );
}

function ConnectionCard({
  data,
  onChange,
  onNotice,
}: {
  data: ClientDetail;
  onChange: () => Promise<void>;
  onNotice: (n: Notice) => void;
}) {
  const { client, connection } = data;
  const confirm = useConfirm();
  const [options, setOptions] = useState<GoogleOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [site, setSite] = useState(client.gscSiteUrl ?? '');
  const [property, setProperty] = useState(client.ga4PropertyId ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const needsPick = connection?.status === 'active' && !client.gscSiteUrl && !client.ga4PropertyId;
  const [editing, setEditing] = useState(needsPick);

  useEffect(() => setEditing(needsPick), [needsPick]);

  useEffect(() => {
    if (!editing || !connection || connection.status !== 'active' || options) return;
    setLoadingOptions(true);
    api<GoogleOptions>(`/api/clients/${client.id}/google/options`)
      .then(setOptions)
      .catch((e: Error) => onNotice({ kind: 'error', text: e.message }))
      .finally(() => setLoadingOptions(false));
  }, [editing, connection, options, client.id, onNotice]);

  async function connect() {
    setBusy('connect');
    try {
      const { url } = await api<{ url: string }>(`/api/clients/${client.id}/google/connect`, {
        method: 'POST',
      });
      window.location.href = url;
    } catch (e) {
      onNotice({ kind: 'error', text: (e as Error).message });
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    try {
      await api(`/api/clients/${client.id}/google/selection`, {
        method: 'PUT',
        body: { gscSiteUrl: site || null, ga4PropertyId: property || null },
      });
      setEditing(false);
      onNotice({ kind: 'success', text: 'Data sources saved. Run a health check to see results.' });
      await onChange();
    } catch (e) {
      onNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: 'Disconnect this Google account?',
      message: 'Search Console and Analytics data will stop updating until you connect again.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy('disconnect');
    try {
      await api(`/api/clients/${client.id}/google`, { method: 'DELETE' });
      setOptions(null);
      await onChange();
    } finally {
      setBusy(null);
    }
  }

  if (!connection || client.status === 'not_connected') {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 border-dashed">
        <div>
          <h2 className="font-semibold">Connect the client's Google account</h2>
          <p className="text-sm text-slate-500">
            Read-only access to Search Console and Google Analytics 4.
          </p>
        </div>
        <Button loading={busy === 'connect'} onClick={connect}>
          Connect Google
        </Button>
      </Card>
    );
  }

  if (connection.status === 'revoked' || client.status === 'reconnect_needed') {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 border-red-200 bg-red-50">
        <div>
          <h2 className="font-semibold text-red-800">⚠ Reconnect needed</h2>
          <p className="text-sm text-red-700">
            Google access for {connection.googleEmail} was revoked or expired. Reconnect to resume
            Search Console and Analytics data.
          </p>
        </div>
        <Button loading={busy === 'connect'} onClick={connect}>
          Reconnect Google
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Google data sources</h2>
          <p className="text-sm text-slate-500">Connected as {connection.googleEmail}</p>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Change
            </Button>
          )}
          <Button variant="danger" loading={busy === 'disconnect'} onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      </div>

      {!editing ? (
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Search Console site</dt>
            <dd className="font-medium">
              {client.gscSiteUrl ?? <span className="text-amber-700">Not selected</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">GA4 property</dt>
            <dd className="font-medium">
              {client.ga4PropertyId ? (
                `Property ${client.ga4PropertyId}`
              ) : (
                <span className="text-amber-700">Not selected</span>
              )}
            </dd>
          </div>
        </dl>
      ) : loadingOptions || !options ? (
        <div className="mt-4 space-y-2" role="status" aria-label="Loading sites and properties">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Search Console site</span>
            <select
              className={`${inputClass} mt-1`}
              value={site}
              onChange={(e) => setSite(e.target.value)}
              disabled={!connection.canReadGsc}
            >
              <option value="">— None —</option>
              {options.sites.map((s) => (
                <option key={s.siteUrl} value={s.siteUrl}>
                  {s.siteUrl}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              {!connection.canReadGsc
                ? 'Search Console permission was not granted.'
                : (options.errors.sites ??
                  (options.sites.length === 0
                    ? 'No verified sites in this Google account.'
                    : `${options.sites.length} site(s) found`))}
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">GA4 property</span>
            <select
              className={`${inputClass} mt-1`}
              value={property}
              onChange={(e) => setProperty(e.target.value)}
              disabled={!connection.canReadGa4}
            >
              <option value="">— None —</option>
              {options.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.account})
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              {!connection.canReadGa4
                ? 'Analytics permission was not granted.'
                : (options.errors.properties ??
                  (options.properties.length === 0
                    ? 'No GA4 properties in this Google account.'
                    : `${options.properties.length} property/properties found`))}
            </span>
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button loading={busy === 'save'} onClick={save} disabled={!site && !property}>
              Save
            </Button>
            {!needsPick && (
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function InsightCard({ insight }: { insight: NonNullable<ClientDetail['insight']> }) {
  const [lang, setLang] = useState<'en' | 'hi'>('en');
  const [items, setItems] = useState<ActionItem[]>(insight.actionItems);
  useEffect(() => setItems(insight.actionItems), [insight.actionItems]);
  const isFallback = insight.modelUsed === 'rule-based-fallback';

  async function toggle(id: string, done: boolean) {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, done } : i)));
    try {
      await api(`/api/action-items/${id}`, { method: 'PATCH', body: { done } });
    } catch {
      setItems((list) => list.map((i) => (i.id === id ? { ...i, done: !done } : i))); // undo on failure
    }
  }

  const doneCount = items.filter((i) => i.done).length;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">This week's action plan</h2>
        {insight.summaryHinglish && (
          <div
            className="flex rounded-lg border border-slate-200 p-0.5 text-xs"
            role="group"
            aria-label="Summary language"
          >
            {(['en', 'hi'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className={`rounded-md px-2.5 py-1 ${lang === l ? 'bg-[var(--brand)] text-white' : 'text-slate-600'}`}
              >
                {l === 'en' ? 'English' : 'Hinglish'}
              </button>
            ))}
          </div>
        )}
      </div>
      {isFallback && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          AI was unavailable for this check, so these recommendations were generated by fixed rules
          from your data.
        </p>
      )}
      <p className="mt-3 leading-relaxed text-slate-700">
        {lang === 'hi' && insight.summaryHinglish ? insight.summaryHinglish : insight.summary}
      </p>
      <div className="mt-5 flex items-center justify-between text-xs text-slate-500">
        <span>
          {doneCount} of {items.length} done
        </span>
        <span>Generated {formatDateTime(insight.createdAt)}</span>
      </div>
      <ol className="mt-2 space-y-2">
        {items.map((a) => (
          <li
            key={a.id}
            className={`flex gap-3 rounded-lg border p-3 ${a.done ? 'border-slate-100 bg-slate-50' : 'border-slate-200'}`}
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 cursor-pointer"
              checked={a.done}
              onChange={(e) => void toggle(a.id, e.target.checked)}
              aria-label={`Mark "${a.title}" as done`}
            />
            <div className="min-w-0">
              <div className={`font-medium ${a.done ? 'text-slate-400 line-through' : ''}`}>
                <span className="mr-2 rounded bg-[var(--brand)]/10 px-1.5 py-0.5 text-xs text-[var(--brand)]">
                  #{a.priority}
                </span>
                {a.title}
              </div>
              {a.description && <p className="mt-1 text-sm text-slate-700">{a.description}</p>}
              <p className="mt-1 text-sm text-slate-600">
                <b className="font-medium">Why:</b> {a.why}
              </p>
              <p className="mt-0.5 text-sm text-slate-600">
                <b className="font-medium">Expected impact:</b> {a.expectedImpact}
              </p>
              {a.supportingMetrics.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {a.supportingMetrics.map((m) => (
                    <li key={m} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {m}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-slate-400">
        Recommendations are suggestions based on your data, not guaranteed results.
      </p>
    </Card>
  );
}

function ReportsCard({
  data,
  onChange,
  onNotice,
}: {
  data: ClientDetail;
  onChange: () => Promise<void>;
  onNotice: (n: Notice) => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  async function generate() {
    setBusy('generate');
    try {
      await api(`/api/clients/${data.client.id}/run`, {
        method: 'POST',
        body: { type: 'monthly_report', send: false },
      });
      onNotice({
        kind: 'info',
        text: 'Report is being generated. It will appear below in about a minute.',
      });
      await onChange();
    } catch (e) {
      onNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function send(reportId: string) {
    const ok = await confirm({
      title: 'Send this report?',
      message: `The PDF report will be emailed to ${data.client.contactEmail} from your agency Gmail.`,
      confirmLabel: 'Send email',
    });
    if (!ok) return;
    setBusy(`send-${reportId}`);
    try {
      await api(`/api/reports/${reportId}/send`, { method: 'POST' });
      onNotice({ kind: 'success', text: `Report sent to ${data.client.contactEmail}.` });
      await onChange();
    } catch (e) {
      onNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function refreshPdf(reportId: string) {
    setBusy(`pdf-${reportId}`);
    try {
      await api(`/api/reports/${reportId}/refresh-pdf`, { method: 'POST' });
      onNotice({ kind: 'success', text: 'PDF updated from your Google Slides edits.' });
      await onChange();
    } catch (e) {
      onNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(path: string) {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      onNotice({ kind: 'success', text: 'Share link copied.' });
    } catch {
      onNotice({ kind: 'info', text: `Share link: ${url}` });
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Monthly reports</h2>
          <p className="text-sm text-slate-500">
            {data.client.autoSendReport
              ? `Auto-sent to ${data.client.contactEmail} on the 1st of every month.`
              : 'Prepared on the 1st of every month for you to preview, edit and send.'}
          </p>
        </div>
        <Button
          variant="secondary"
          loading={busy === 'generate' || data.pending.report}
          onClick={generate}
        >
          {data.pending.report ? 'Generating…' : 'Generate preview now'}
        </Button>
      </div>
      {data.reports.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">No reports yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {data.reports.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{formatMonth(r.month)}</span>
                <StatusBadge status={r.status} />
                <span className="text-xs text-slate-500">
                  Created {formatDateTime(r.createdAt)}
                  {r.sentAt && ` · sent ${formatDateTime(r.sentAt)}`}
                </span>
              </div>
              {r.error && <div className="mt-1 text-xs text-red-600">{r.error}</div>}
              {(r.status === 'ready' || r.status === 'sent') && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <a href={`/api/reports/${r.id}/pdf`} target="_blank" rel="noreferrer">
                    <Button variant="secondary">Preview PDF</Button>
                  </a>
                  {r.slidesFileId && (
                    <>
                      <a
                        href={`https://docs.google.com/presentation/d/${encodeURIComponent(r.slidesFileId)}/edit`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Button variant="secondary">Edit in Google Slides</Button>
                      </a>
                      <Button
                        variant="secondary"
                        loading={busy === `pdf-${r.id}`}
                        onClick={() => void refreshPdf(r.id)}
                      >
                        Re-export PDF
                      </Button>
                    </>
                  )}
                  <Button variant="secondary" onClick={() => void copyLink(r.shareUrl)}>
                    Copy share link
                  </Button>
                  <Button loading={busy === `send-${r.id}`} onClick={() => void send(r.id)}>
                    {r.status === 'sent' ? 'Send again' : 'Send to client'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-400">
        Tip: open the report in Google Slides, make changes, then click “Re-export PDF” before
        sending.
      </p>
    </Card>
  );
}
