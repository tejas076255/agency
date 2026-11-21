// Client tabs for Phase 2/3: Local SEO (Business Profile, reviews, competitors), Google Ads,
// YouTube and exports. Data comes from GET /api/clients/:id/integrations.
import { useEffect, useState, type ReactNode } from 'react';
import { ChangePill } from '../components/badges';
import { TrendChart } from '../components/charts';
import { useConfirm } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatDateTime, formatDay, formatMonth, formatNumber } from '../lib/format';
import type { Integrations, PlaceResult, ProductState, ReviewRow } from '../lib/types';

type Notify = (kind: 'success' | 'error' | 'info', text: string) => void;
type Product = 'gbp' | 'ads' | 'youtube';

const PRODUCT_INFO: Record<Product, { name: string; what: string; approval: string }> = {
  gbp: {
    name: 'Google Business Profile',
    what: 'Calls, direction requests, website clicks, listing info and reviews.',
    approval:
      'Needs Google approval of Business Profile API access for this app. Until approved, Google returns a “quota 0” error.',
  },
  ads: {
    name: 'Google Ads',
    what: 'Spend, clicks, conversions, ROAS and wasted search terms.',
    approval: 'Needs a Google Ads developer token with Basic Access to read real client accounts.',
  },
  youtube: {
    name: 'YouTube',
    what: 'Views, watch time, subscribers and top videos (channel owner must connect).',
    approval: 'No special approval; the channel owner signs in with Google.',
  },
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold">{value}</div>
      <div className="mt-1 min-h-4">{sub}</div>
    </Card>
  );
}

const money = (currency: string | null | undefined, n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : n.toLocaleString('en-IN', {
        style: 'currency',
        currency: currency || 'INR',
        maximumFractionDigits: 0,
      });

/** Connect / pick / disconnect card shared by all products. */
export function ProductCard({
  clientId,
  product,
  state,
  onChange,
  notify,
}: {
  clientId: string;
  product: Product;
  state: ProductState<unknown>;
  onChange: () => Promise<void>;
  notify: Notify;
}) {
  const info = PRODUCT_INFO[product];
  const confirm = useConfirm();
  const [options, setOptions] = useState<
    { id: string; label: string; accountName?: string }[] | null
  >(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const conn = state.connection;
  const needsPick = conn?.status === 'active' && !state.selected;

  useEffect(() => {
    if (!(needsPick || picking) || options) return;
    api<{ options: { id: string; label: string; accountName?: string }[] }>(
      `/api/clients/${clientId}/integrations/${product}/options`,
    )
      .then((r) => setOptions(r.options))
      .catch((e: Error) => setOptionsError(e.message));
  }, [needsPick, picking, options, clientId, product]);

  async function connect() {
    setBusy('connect');
    try {
      const { url } = await api<{ url: string }>(
        `/api/clients/${clientId}/integrations/${product}/connect`,
        { method: 'POST' },
      );
      window.location.href = url;
    } catch (e) {
      notify('error', (e as Error).message);
      setBusy(null);
    }
  }

  async function save() {
    const opt = options?.find((o) => o.id === choice);
    if (!opt) return;
    setBusy('save');
    try {
      await api(`/api/clients/${clientId}/integrations/${product}/selection`, {
        method: 'PUT',
        body: { id: opt.id, accountName: opt.accountName },
      });
      notify(
        'success',
        `${info.name} selected. Click “Run health check” on the Overview tab to sync data.`,
      );
      setPicking(false);
      await onChange();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: `Disconnect ${info.name}?`,
      message: 'The Google token is revoked and data stops syncing. Past data stays visible.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy('disconnect');
    await api(`/api/clients/${clientId}/integrations/${product}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
    setOptions(null);
    await onChange();
    setBusy(null);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{info.name}</h2>
          <p className="text-sm text-slate-500">{info.what}</p>
          {conn && (
            <p className="mt-1 text-xs text-slate-500">
              {conn.status === 'active' ? '● Connected' : '⚠ Access revoked'} as {conn.googleEmail}
              {state.selected && ` · selected: ${state.selected}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(!conn || conn.status === 'revoked') && (
            <Button loading={busy === 'connect'} onClick={connect}>
              {conn ? 'Reconnect' : 'Connect'}
            </Button>
          )}
          {conn?.status === 'active' && state.selected && !picking && (
            <Button variant="secondary" onClick={() => setPicking(true)}>
              Change
            </Button>
          )}
          {conn && (
            <Button variant="danger" loading={busy === 'disconnect'} onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {!conn && <p className="mt-3 text-xs text-slate-500">ℹ {info.approval}</p>}
      {(needsPick || picking) && (
        <div className="mt-4">
          {optionsError ? (
            <Alert>{optionsError}</Alert>
          ) : !options ? (
            <Skeleton className="h-10" />
          ) : options.length === 0 ? (
            <Alert kind="info">Nothing found in this Google account.</Alert>
          ) : (
            <div className="flex flex-wrap gap-2">
              <select
                className={`${inputClass} max-w-lg`}
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                aria-label={`Choose ${info.name}`}
              >
                <option value="">— Choose —</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Button loading={busy === 'save'} disabled={!choice} onClick={save}>
                Save
              </Button>
              {picking && (
                <Button variant="secondary" onClick={() => setPicking(false)}>
                  Cancel
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {state.latest?.status === 'failed' && (
        <div className="mt-3">
          <Alert>
            Last sync {formatDateTime(state.latest.runAt)} failed: {state.latest.error}
          </Alert>
        </div>
      )}
      {state.latest?.status === 'ok' && (
        <p className="mt-3 text-xs text-slate-400">
          Last synced {formatDateTime(state.latest.runAt)} · syncs with every health check (Mondays
          6:00 AM IST)
        </p>
      )}
    </Card>
  );
}

// ------------------------------------ Local SEO ------------------------------------

export function LocalSeoTab({
  clientId,
  data,
  reload,
  notify,
}: {
  clientId: string;
  data: Integrations;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const gbp = data.gbp.latest?.data ?? null;
  return (
    <div className="space-y-6">
      <ProductCard
        clientId={clientId}
        product="gbp"
        state={data.gbp}
        onChange={reload}
        notify={notify}
      />
      {gbp && (
        <>
          <section
            aria-label="Business Profile metrics"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <Stat
              label="Profile views (search + maps)"
              value={formatNumber(gbp.totals.current.impressions)}
              sub={<ChangePill pct={gbp.changePct.impressions} />}
            />
            <Stat
              label="Calls"
              value={formatNumber(gbp.totals.current.calls)}
              sub={<ChangePill pct={gbp.changePct.calls} />}
            />
            <Stat
              label="Direction requests"
              value={formatNumber(gbp.totals.current.directions)}
              sub={<ChangePill pct={gbp.changePct.directions} />}
            />
            <Stat
              label="Website clicks"
              value={formatNumber(gbp.totals.current.websiteClicks)}
              sub={<ChangePill pct={gbp.changePct.websiteClicks} />}
            />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Daily calls</h3>
              <TrendChart
                data={gbp.daily}
                xKey="date"
                yKey="calls"
                name="Calls"
                formatX={(v) => formatDay(String(v))}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Listing</h3>
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-slate-500">Name</dt>
                <dd>{gbp.location.title}</dd>
                <dt className="text-slate-500">Category</dt>
                <dd>{gbp.location.primaryCategory ?? <Missing />}</dd>
                <dt className="text-slate-500">Address</dt>
                <dd>{gbp.location.address || <Missing />}</dd>
                <dt className="text-slate-500">Phone</dt>
                <dd>{gbp.location.phone ?? <Missing />}</dd>
                <dt className="text-slate-500">Website</dt>
                <dd className="truncate">{gbp.location.website ?? <Missing />}</dd>
                <dt className="text-slate-500">Hours</dt>
                <dd>{gbp.location.hoursSet ? 'Set' : <Missing />}</dd>
                <dt className="text-slate-500">Rating</dt>
                <dd>
                  {gbp.reviews.averageRating ?? '—'} ★ ({formatNumber(gbp.reviews.totalReviewCount)}{' '}
                  reviews)
                </dd>
              </dl>
              {gbp.location.mapsUri && (
                <a
                  href={gbp.location.mapsUri}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block text-sm text-[var(--brand)] hover:underline"
                >
                  Open in Google Maps ↗
                </a>
              )}
            </Card>
          </div>
        </>
      )}
      <ReviewsSection clientId={clientId} data={data} reload={reload} notify={notify} />
      <CompetitorsSection clientId={clientId} data={data} reload={reload} notify={notify} />
    </div>
  );
}

function Missing() {
  return <span className="text-amber-700">⚠ Missing</span>;
}

const LABEL_STYLE: Record<string, string> = {
  positive: 'bg-green-50 text-green-700',
  neutral: 'bg-slate-100 text-slate-600',
  negative: 'bg-red-50 text-red-700',
};

function ReviewsSection({
  clientId,
  data,
  reload,
  notify,
}: {
  clientId: string;
  data: Integrations;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const r = data.reviews;
  const [filter, setFilter] = useState<'all' | 'negative' | 'unanswered'>('all');
  if (r.recent.length === 0) {
    return (
      <Card>
        <h2 className="font-semibold">Reviews</h2>
        <p className="py-4 text-sm text-slate-400">
          No reviews synced yet. Connect Business Profile and run a health check.
        </p>
      </Card>
    );
  }
  const shown = r.recent.filter((x) =>
    filter === 'all'
      ? true
      : filter === 'negative'
        ? x.label === 'negative' || (x.starRating ?? 5) <= 2
        : !x.replyComment,
  );
  const total = r.sentimentCounts.positive + r.sentimentCounts.neutral + r.sentimentCounts.negative;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <h3 className="text-sm font-semibold">Sentiment (AI-derived)</h3>
          {!data.config.naturalLanguage && (
            <p className="mt-1 text-xs text-amber-700">
              Natural Language API not configured, so sentiment is not analysed.
            </p>
          )}
          <ul className="mt-3 space-y-2 text-sm">
            {(['positive', 'neutral', 'negative'] as const).map((k) => (
              <li key={k} className="flex items-center gap-2">
                <span
                  className={`w-20 rounded px-2 py-0.5 text-center text-xs capitalize ${LABEL_STYLE[k]}`}
                >
                  {k}
                </span>
                <div className="h-2 flex-1 rounded bg-slate-100">
                  <div
                    className="h-2 rounded bg-[var(--brand)]"
                    style={{ width: total ? `${(r.sentimentCounts[k] / total) * 100}%` : 0 }}
                  />
                </div>
                <span className="w-8 text-right tabular-nums">{r.sentimentCounts[k]}</span>
              </li>
            ))}
          </ul>
          {r.stats && (
            <p className="mt-3 text-xs text-slate-500">
              Last 30 days: {r.stats.recent30} new · {r.stats.negative30} negative ·{' '}
              {r.stats.unanswered} unanswered
            </p>
          )}
        </Card>
        <Card>
          <h3 className="text-sm font-semibold">Common complaints</h3>
          <Themes items={r.themes.negative} empty="No negative themes found" />
          <h3 className="mt-4 text-sm font-semibold">What customers like</h3>
          <Themes items={r.themes.positive} empty="No positive themes yet" />
        </Card>
        <Card>
          <h3 className="mb-3 text-sm font-semibold">Reviews per month</h3>
          <TrendChart
            data={r.trend}
            xKey="month"
            yKey="count"
            name="Reviews"
            formatX={(v) => formatMonth(String(v)).split(' ')[0]!.slice(0, 3)}
            height={180}
          />
        </Card>
      </div>
      {r.stats && r.stats.negative30 > 0 && (
        <Alert>
          ⚠ {r.stats.negative30} negative review(s) in the last 30 days. Replying quickly helps.
        </Alert>
      )}
      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <h2 className="font-semibold">Recent reviews</h2>
          <div className="flex gap-1 text-xs" role="group" aria-label="Filter reviews">
            {(['all', 'negative', 'unanswered'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`rounded-full px-3 py-1 capitalize ${filter === f ? 'bg-[var(--brand)] text-white' : 'bg-slate-100 text-slate-600'}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <ul className="mt-3 divide-y divide-slate-100">
          {shown.slice(0, 30).map((x) => (
            <ReviewItem key={x.id} clientId={clientId} review={x} reload={reload} notify={notify} />
          ))}
        </ul>
      </Card>
    </>
  );
}

function Themes({ items, empty }: { items: { name: string; count: number }[]; empty: string }) {
  if (items.length === 0) return <p className="mt-1 text-xs text-slate-400">{empty}</p>;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {items.map((t) => (
        <li key={t.name} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
          {t.name} · {t.count}
        </li>
      ))}
    </ul>
  );
}

function ReviewItem({
  clientId,
  review,
  reload,
  notify,
}: {
  clientId: string;
  review: ReviewRow;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      await api(`/api/clients/${clientId}/reviews/${review.id}/reply`, {
        method: 'POST',
        body: { comment: text },
      });
      notify('success', 'Reply posted on Google.');
      setReplying(false);
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-amber-500" aria-label={`${review.starRating ?? 0} stars`}>
          {'★'.repeat(review.starRating ?? 0)}
          <span className="text-slate-300">{'★'.repeat(5 - (review.starRating ?? 0))}</span>
        </span>
        <span className="font-medium">{review.reviewerName ?? 'Google user'}</span>
        {review.reviewCreatedAt && (
          <span className="text-xs text-slate-400">{formatDate(review.reviewCreatedAt)}</span>
        )}
        {review.label && (
          <span
            className={`rounded px-1.5 py-0.5 text-xs capitalize ${LABEL_STYLE[review.label]}`}
            title="AI-derived sentiment"
          >
            {review.label}
          </span>
        )}
      </div>
      {review.comment && <p className="mt-1 text-slate-700">{review.comment}</p>}
      {review.replyComment ? (
        <p className="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <b>Owner reply:</b> {review.replyComment}
        </p>
      ) : replying ? (
        <div className="mt-2 space-y-2">
          <textarea
            className={`${inputClass} min-h-20`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
            aria-label="Reply text"
            placeholder="Thank you for your feedback…"
          />
          <div className="flex gap-2">
            <Button loading={busy} disabled={text.trim().length < 2} onClick={send}>
              Post reply on Google
            </Button>
            <Button variant="secondary" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          className="mt-2 text-xs text-[var(--brand)] hover:underline"
          onClick={() => setReplying(true)}
        >
          Reply
        </button>
      )}
    </li>
  );
}

function CompetitorsSection({
  clientId,
  data,
  reload,
  notify,
}: {
  clientId: string;
  data: Integrations;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [live, setLive] = useState<{
    ranked: (PlaceResult & { label: string; isClient: boolean; competitorId: string })[];
    clientRank: number | null;
    competitorAvgRating: number | null;
    competitorAvgReviews: number | null;
    failed: number;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function loadLive() {
    if (data.competitors.length === 0) return setLive(null);
    try {
      setLive(await api(`/api/clients/${clientId}/competitors/live`));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }
  useEffect(() => {
    if (data.config.places) void loadLive();
  }, [data.competitors.length, data.config.places]);

  if (!data.config.places) {
    return (
      <Card>
        <h2 className="font-semibold">Competitors</h2>
        <p className="mt-1 text-sm text-slate-500">
          Places API (New) is not configured. Add a <code>PLACES_API_KEY</code> secret (billing must
          be enabled on the Google Cloud project) to compare ratings with local competitors.
        </p>
      </Card>
    );
  }

  async function search() {
    setBusy('search');
    try {
      setResults(
        (
          await api<{ results: PlaceResult[] }>(
            `/api/clients/${clientId}/competitors/search?q=${encodeURIComponent(q)}`,
          )
        ).results,
      );
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function add(p: PlaceResult, isClient: boolean) {
    setBusy(p.placeId);
    try {
      await api(`/api/clients/${clientId}/competitors`, {
        method: 'POST',
        body: { placeId: p.placeId, label: p.name, isClient },
      });
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string, label: string) {
    if (
      !(await confirm({ title: `Stop tracking ${label}?`, confirmLabel: 'Remove', danger: true }))
    )
      return;
    await api(`/api/clients/${clientId}/competitors/${id}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
    await reload();
  }

  return (
    <Card>
      <h2 className="font-semibold">Competitors</h2>
      <p className="text-sm text-slate-500">
        Ratings and review counts are fetched live from Google each time (not stored). Up to 10
        places.
      </p>
      {live && live.ranked.length > 0 && (
        <>
          <p className="mt-3 text-sm">
            {live.clientRank ? (
              <>
                Your client ranks <b>#{live.clientRank}</b> of {live.ranked.length} by rating.{' '}
              </>
            ) : (
              'Add the client’s own listing (“This is my client”) to see its rank. '
            )}
            Competitor average: <b>{live.competitorAvgRating ?? '—'} ★</b>,{' '}
            {formatNumber(live.competitorAvgReviews)} reviews.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th scope="col" className="py-2 font-medium">
                    Business
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Rating
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Reviews
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {live.ranked.map((p) => (
                  <tr
                    key={p.placeId}
                    className={`border-b border-slate-100 last:border-0 ${p.isClient ? 'bg-[var(--brand)]/5 font-medium' : ''}`}
                  >
                    <td className="py-2">
                      {p.name}
                      {p.isClient && ' (client)'}
                    </td>
                    <td className="py-2 text-right tabular-nums">{p.rating ?? '—'}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatNumber(p.userRatingCount)}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => void remove(p.competitorId, p.name)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            Data © Google{live.failed > 0 && ` · ${live.failed} place(s) could not be loaded`}
          </p>
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <input
          className={`${inputClass} max-w-sm`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. dentist in Kothrud Pune"
          aria-label="Search local businesses"
          onKeyDown={(e) => e.key === 'Enter' && q.length >= 3 && void search()}
        />
        <Button
          variant="secondary"
          loading={busy === 'search'}
          disabled={q.trim().length < 3}
          onClick={search}
        >
          Search
        </Button>
      </div>
      {results && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {results.length === 0 && <li className="py-2 text-slate-400">No results.</li>}
          {results.map((p) => (
            <li key={p.placeId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <b>{p.name}</b>{' '}
                <span className="text-slate-500">
                  · {p.rating ?? '—'} ★ ({formatNumber(p.userRatingCount)})
                </span>
                <span className="block truncate text-xs text-slate-400">{p.address}</span>
              </span>
              <span className="flex gap-2">
                <Button
                  variant="secondary"
                  loading={busy === p.placeId}
                  onClick={() => void add(p, false)}
                >
                  Track competitor
                </Button>
                <Button variant="secondary" onClick={() => void add(p, true)}>
                  This is my client
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------ Google Ads ------------------------------------

export function AdsTab({
  clientId,
  data,
  reload,
  notify,
}: {
  clientId: string;
  data: Integrations;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const ads = data.ads.latest?.data ?? null;
  return (
    <div className="space-y-6">
      {!data.config.adsDeveloperToken && (
        <Alert kind="info">
          Google Ads is not configured on the server yet (missing GOOGLE_ADS_DEVELOPER_TOKEN). See
          docs/API_INTEGRATIONS.md.
        </Alert>
      )}
      <ProductCard
        clientId={clientId}
        product="ads"
        state={data.ads}
        onChange={reload}
        notify={notify}
      />
      {ads && (
        <>
          <section aria-label="Ads metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Spend (28 days)"
              value={money(ads.currency, ads.totals.current.cost)}
              sub={<ChangePill pct={ads.changePct.cost} />}
            />
            <Stat
              label="Clicks"
              value={formatNumber(ads.totals.current.clicks)}
              sub={
                <span className="text-xs text-slate-500">
                  CTR {ads.derived.ctrPct ?? '—'}% · CPC {money(ads.currency, ads.derived.avgCpc)}
                </span>
              }
            />
            <Stat
              label="Conversions"
              value={formatNumber(ads.totals.current.conversions)}
              sub={
                <span className="text-xs text-slate-500">
                  Cost/conv. {money(ads.currency, ads.derived.costPerConversion)}
                </span>
              }
            />
            <Stat
              label="ROAS"
              value={ads.derived.roas === null ? '—' : `${ads.derived.roas}x`}
              sub={
                <span className="text-xs text-slate-500">
                  {ads.derived.roas === null
                    ? 'Conversion values not tracked'
                    : 'Conversion value ÷ spend'}
                </span>
              }
            />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Daily spend</h3>
              <TrendChart
                data={ads.daily}
                xKey="date"
                yKey="cost"
                name="Spend"
                formatX={(v) => formatDay(String(v))}
                formatY={(v) => money(ads.currency, v)}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Wasted search terms</h3>
              <p className="text-xs text-slate-500">
                Spent money, zero conversions (consider negative keywords). Total:{' '}
                {money(ads.currency, ads.wastedSpend)}
              </p>
              <SimpleTable
                head={['Search term', 'Campaign', 'Cost']}
                rows={ads.wastedSearchTerms
                  .slice(0, 10)
                  .map((w) => [w.term, w.campaign, money(ads.currency, w.cost)])}
                empty="No wasted terms found 🎉"
              />
            </Card>
          </div>
          <Card>
            <h3 className="font-semibold">Campaigns</h3>
            <SimpleTable
              head={['Campaign', 'Status', 'Spend', 'Clicks', 'Conv.', 'Budget used']}
              rows={ads.campaigns.map((c) => [
                c.name,
                c.status.toLowerCase(),
                money(ads.currency, c.cost),
                formatNumber(c.clicks),
                formatNumber(c.conversions),
                c.budgetUtilizationPct === null ? '—' : `${c.budgetUtilizationPct}%`,
              ])}
              empty="No campaigns with activity"
            />
          </Card>
        </>
      )}
    </div>
  );
}

// ------------------------------------ YouTube ------------------------------------

export function YouTubeTab({
  clientId,
  data,
  reload,
  notify,
}: {
  clientId: string;
  data: Integrations;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const yt = data.youtube.latest?.data ?? null;
  const net = yt ? yt.totals.current.subscribersGained - yt.totals.current.subscribersLost : null;
  return (
    <div className="space-y-6">
      <ProductCard
        clientId={clientId}
        product="youtube"
        state={data.youtube}
        onChange={reload}
        notify={notify}
      />
      {yt && (
        <>
          <section aria-label="YouTube metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Views (28 days)"
              value={formatNumber(yt.totals.current.views)}
              sub={<ChangePill pct={yt.changePct.views} />}
            />
            <Stat
              label="Watch time (hours)"
              value={formatNumber(yt.totals.current.watchMinutes / 60)}
              sub={<ChangePill pct={yt.changePct.watchMinutes} />}
            />
            <Stat
              label="Net subscribers"
              value={net === null ? '—' : `${net >= 0 ? '+' : ''}${formatNumber(net)}`}
              sub={
                <span className="text-xs text-slate-500">
                  +{yt.totals.current.subscribersGained} / −{yt.totals.current.subscribersLost}
                </span>
              }
            />
            <Stat
              label="Avg. view duration"
              value={`${Math.floor(yt.totals.current.avgViewDurationSec / 60)}:${String(Math.round(yt.totals.current.avgViewDurationSec % 60)).padStart(2, '0')}`}
              sub={
                <span className="text-xs text-slate-500">
                  {formatNumber(yt.channel.subscribers)} subscribers total
                </span>
              }
            />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Daily views</h3>
              <TrendChart
                data={yt.daily}
                xKey="date"
                yKey="views"
                name="Views"
                formatX={(v) => formatDay(String(v))}
              />
            </Card>
            <Card>
              <h3 className="font-semibold">Top videos (28 days)</h3>
              <SimpleTable
                head={['Video', 'Views', 'Watch hrs']}
                rows={yt.topVideos.map((v) => [
                  v.title,
                  formatNumber(v.views),
                  formatNumber(v.watchMinutes / 60),
                ])}
                empty="No video data"
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------ Exports ------------------------------------

export function ExportsTab({
  clientId,
  data,
  reload,
  notify,
}: {
  clientId: string;
  data: Integrations;
  reload: () => Promise<void>;
  notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  async function exportNow() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/api/clients/${clientId}/exports/sheets`, {
        method: 'POST',
      });
      notify('success', 'Spreadsheet created in your Google Drive.');
      window.open(url, '_blank', 'noopener');
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="font-semibold">Export to Google Sheets</h2>
      <p className="text-sm text-slate-500">
        Creates a formatted spreadsheet in the agency’s Google Drive with search, GA4, Business
        Profile, reviews (AI-derived columns marked), Ads and YouTube data that is available.
      </p>
      {!data.config.workspaceConnected && (
        <div className="mt-3">
          <Alert kind="info">Connect the agency Google account in Settings first.</Alert>
        </div>
      )}
      <Button
        className="mt-4"
        loading={busy}
        disabled={!data.config.workspaceConnected}
        onClick={exportNow}
      >
        Export now
      </Button>
      {data.exports.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 text-sm">
          {data.exports.map((e) => (
            <li key={e.id} className="flex justify-between gap-3 py-2">
              <span>{formatDateTime(e.createdAt)}</span>
              {e.status === 'ok' && e.url ? (
                <a
                  className="text-[var(--brand)] hover:underline"
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open sheet ↗
                </a>
              ) : (
                <span className="text-xs text-red-600">{e.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SimpleTable({
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
    <div className="mt-2 overflow-x-auto">
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
                  className={`py-2 ${j > 0 ? 'whitespace-nowrap pl-3 text-right tabular-nums' : 'max-w-[18rem] truncate'}`}
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

/** Loads integrations once for the client tabs. */
export function useIntegrations(clientId: string) {
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    try {
      setData(await api<Integrations>(`/api/clients/${clientId}/integrations`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void reload();
  }, [clientId]);
  return { data, error, reload };
}
