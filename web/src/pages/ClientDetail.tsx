import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChangePill, ClientStatusBadge, ScoreBadge, StatusBadge } from '../components/badges';
import { TrendChart } from '../components/charts';
import { Alert, Button, Card, Spinner, inputClass } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDate, formatDateTime, formatDay, formatMonth, formatNumber } from '../lib/format';
import type { ClientDetail, GoogleOptions } from '../lib/types';

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
};

export function ClientDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(
    null,
  );

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
    if (params.get('connected'))
      setNotice({
        kind: 'success',
        text: 'Google account connected. Now pick the Search Console site and GA4 property.',
      });
    const err = params.get('connect_error');
    if (err) setNotice({ kind: 'error', text: CONNECT_ERRORS[err] ?? 'Google connection failed.' });
    if (params.get('connected') || err) setParams({}, { replace: true });
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
  if (!data) return <Spinner label="Loading client…" />;

  const { client, latestCheck: check, insight } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/dashboard" className="text-sm text-slate-500 hover:text-slate-800">
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

      <ConnectionCard data={data} onChange={load} onNotice={setNotice} />

      {data.pending.healthCheck && (
        <Alert kind="info">
          ⟳ Health check is running. This page updates automatically (takes 1-2 minutes).
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
                </div>
                <p className="text-sm text-slate-500">
                  Last checked {formatDateTime(check.runAt)} · covers the last 28 days
                </p>
                {check.breakdown && (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {(['seo', 'traffic', 'speed'] as const).map((k) => {
                      const s = check.breakdown?.[k];
                      return (
                        <span
                          key={k}
                          className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700"
                        >
                          {k === 'seo' ? 'SEO' : k === 'traffic' ? 'Traffic' : 'Speed'}:{' '}
                          {s ? `${s.points}/${s.max}` : 'no data'}
                        </span>
                      );
                    })}
                  </div>
                )}
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
          </Card>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label="Search clicks"
              value={formatNumber(check.gsc?.totals.current.clicks)}
              sub={check.gsc && <ChangePill pct={check.gsc.clicksChangePct} />}
            />
            <Kpi
              label="Sessions"
              value={formatNumber(check.ga4?.totals.current.sessions)}
              sub={check.ga4 && <ChangePill pct={check.ga4.sessionsChangePct} />}
            />
            <Kpi
              label="Key events (leads)"
              value={formatNumber(check.ga4?.totals.current.keyEvents)}
              sub={check.ga4 && <ChangePill pct={check.ga4.keyEventsChangePct} />}
            />
            <Kpi
              label="Avg. Google position"
              value={check.gsc ? check.gsc.totals.current.position.toFixed(1) : '—'}
              sub={
                check.gsc && (
                  <span className="text-xs text-slate-500">
                    CTR {(check.gsc.totals.current.ctr * 100).toFixed(1)}%
                  </span>
                )
              }
            />
            <Kpi
              label="Mobile speed"
              value={check.pagespeed?.mobile ? `${check.pagespeed.mobile.score}/100` : '—'}
              sub={<Vitals s={check.pagespeed?.mobile} />}
            />
            <Kpi
              label="Desktop speed"
              value={check.pagespeed?.desktop ? `${check.pagespeed.desktop.score}/100` : '—'}
              sub={<Vitals s={check.pagespeed?.desktop} />}
            />
            <Kpi
              label="Users"
              value={formatNumber(check.ga4?.totals.current.users)}
              sub={check.ga4 && <ChangePill pct={check.ga4.usersChangePct} />}
            />
            <Kpi
              label="Engagement rate"
              value={check.ga4 ? `${check.ga4.totals.current.engagementRate}%` : '—'}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Daily search clicks</h3>
              <TrendChart
                data={check.gsc?.dailyClicks ?? []}
                xKey="date"
                yKey="clicks"
                name="Clicks"
                formatX={(v) => formatDay(String(v))}
              />
            </Card>
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Daily sessions</h3>
              <TrendChart
                data={check.ga4?.dailySessions ?? []}
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
          AI action items will appear here after a health check with data.{' '}
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
              empty={check.gsc ? 'No quick wins found' : 'Search Console not connected'}
              head={['Keyword', 'Impressions', 'Position']}
              rows={(check.gsc?.quickWins ?? []).map((q) => [
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
              empty={check.gsc ? 'No pages lost clicks 🎉' : 'Search Console not connected'}
              head={['Page', 'Before', 'Now']}
              rows={(check.gsc?.droppingPages ?? []).map((p) => [
                shortUrl(p.page),
                formatNumber(p.clicksBefore),
                formatNumber(p.clicksNow),
              ])}
            />
          </Card>
          <Card>
            <h3 className="font-semibold">Top search queries</h3>
            <Table
              empty={check.gsc ? 'No queries yet' : 'Search Console not connected'}
              head={['Query', 'Clicks', 'Position']}
              rows={(check.gsc?.topQueries ?? [])
                .slice(0, 8)
                .map((q) => [q.query, formatNumber(q.clicks), q.position.toFixed(1)])}
            />
          </Card>
          <Card>
            <h3 className="font-semibold">Speed fixes (mobile)</h3>
            <Table
              empty={check.pagespeed?.mobile ? 'No big opportunities' : 'No speed data'}
              head={['Fix', 'Potential saving']}
              rows={(check.pagespeed?.mobile?.opportunities ?? []).map((o) => [
                o.title,
                `${(o.savingsMs / 1000).toFixed(1)} s`,
              ])}
            />
            {check.ga4 && check.ga4.topChannels.length > 0 && (
              <>
                <h3 className="mt-5 font-semibold">Top traffic channels</h3>
                <Table
                  head={['Channel', 'Sessions']}
                  rows={check.ga4.topChannels.map((c) => [c.channel, formatNumber(c.sessions)])}
                  empty=""
                />
              </>
            )}
          </Card>
        </div>
      )}

      <ReportsCard data={data} onChange={load} onNotice={setNotice} />
    </div>
  );
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.pathname + x.search || '/';
  } catch {
    return u;
  }
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold">{value}</div>
      <div className="mt-1 min-h-4">{sub}</div>
    </Card>
  );
}

function Vitals({
  s,
}: {
  s?: { lcpMs: number | null; cls: number | null; inpMs: number | null } | null;
}) {
  if (!s) return null;
  return (
    <span className="text-xs text-slate-500">
      LCP {s.lcpMs !== null ? `${(s.lcpMs / 1000).toFixed(1)}s` : '—'} · CLS {s.cls ?? '—'} · INP{' '}
      {s.inpMs !== null ? `${s.inpMs}ms` : '—'}
    </span>
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
              <th key={h} className={`py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>
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
  onNotice: (n: { kind: 'success' | 'error' | 'info'; text: string }) => void;
}) {
  const { client, connection } = data;
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
    if (
      !confirm(
        'Disconnect this Google account? Search Console and Analytics data will stop updating.',
      )
    )
      return;
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
        <Spinner label="Loading sites and properties from Google…" />
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
                    : `${options.properties.length} propert${options.properties.length === 1 ? 'y' : 'ies'} found`))}
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
  const [items, setItems] = useState(insight.actionItems);
  useEffect(() => setItems(insight.actionItems), [insight.actionItems]);

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
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs">
            {(['en', 'hi'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`rounded-md px-2.5 py-1 ${lang === l ? 'bg-[var(--brand)] text-white' : 'text-slate-600'}`}
              >
                {l === 'en' ? 'English' : 'Hinglish'}
              </button>
            ))}
          </div>
        )}
      </div>
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
              <p className="mt-1 text-sm text-slate-600">
                <b className="font-medium">Why:</b> {a.why}
              </p>
              <p className="mt-0.5 text-sm text-slate-600">
                <b className="font-medium">Expected impact:</b> {a.expectedImpact}
              </p>
            </div>
          </li>
        ))}
      </ol>
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
  onNotice: (n: { kind: 'success' | 'error' | 'info'; text: string }) => void;
}) {
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
    if (!confirm(`Email this report to ${data.client.contactEmail}?`)) return;
    setBusy(reportId);
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

  async function copyLink(path: string) {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      onNotice({ kind: 'success', text: 'Share link copied.' });
    } catch {
      prompt('Copy this link:', url);
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
              : 'Prepared on the 1st of every month for you to preview and send.'}
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
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatMonth(r.month)}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="text-xs text-slate-500">
                  Created {formatDateTime(r.createdAt)}
                  {r.sentAt && ` · sent ${formatDateTime(r.sentAt)}`}
                </div>
                {r.error && <div className="mt-1 text-xs text-red-600">{r.error}</div>}
              </div>
              {(r.status === 'ready' || r.status === 'sent') && (
                <div className="flex flex-wrap gap-2">
                  <a href={`/api/reports/${r.id}/pdf`} target="_blank" rel="noreferrer">
                    <Button variant="secondary">Preview PDF</Button>
                  </a>
                  <Button variant="secondary" onClick={() => void copyLink(r.shareUrl)}>
                    Copy share link
                  </Button>
                  <Button loading={busy === r.id} onClick={() => void send(r.id)}>
                    {r.status === 'sent' ? 'Send again' : 'Send to client'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
