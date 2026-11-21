// Agency-wide pages for Phase 2/3 channels and Phase 4 billing.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChangePill } from '../components/badges';
import { ListSkeleton } from '../components/Skeleton';
import { Alert, Card } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, formatInr, formatNumber } from '../lib/format';
import type { Billing, ChannelOverviewRow } from '../lib/types';

function useOverview() {
  const [rows, setRows] = useState<ChannelOverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ clients: ChannelOverviewRow[] }>('/api/channels/overview')
      .then((r) => setRows(r.clients))
      .catch((e: Error) => setError(e.message));
  }, []);
  return { rows, error };
}

function PageShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="text-sm text-slate-500">{intro}</p>
      </div>
      {children}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`px-4 py-2 font-medium ${i > 0 ? 'text-right' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {r.map((cell, j) => (
                <td key={j} className={`px-4 py-2 ${j > 0 ? 'text-right tabular-nums' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const clientLink = (r: ChannelOverviewRow, tab: string) => (
  <Link to={`/clients/${r.id}?tab=${tab}`} className="font-medium hover:underline">
    {r.name}
  </Link>
);

function NotSetUp({
  rows,
  tab,
  label,
}: {
  rows: ChannelOverviewRow[];
  tab: string;
  label: string;
}) {
  if (rows.length === 0) return null;
  return (
    <p className="text-sm text-slate-500">
      Not set up yet for:{' '}
      {rows.map((r, i) => (
        <span key={r.id}>
          {i > 0 && ', '}
          <Link className="text-[var(--brand)] hover:underline" to={`/clients/${r.id}?tab=${tab}`}>
            {r.name}
          </Link>
        </span>
      ))}
      . Open a client → {label} tab → Connect.
    </p>
  );
}

export function LocalSeoPage() {
  const { rows, error } = useOverview();
  const active = rows?.filter((r) => r.gbpSelected) ?? [];
  return (
    <PageShell
      title="Local SEO"
      intro="Google Business Profile performance and reviews across clients (last 28 days)."
    >
      {error && <Alert>{error}</Alert>}
      {!rows && !error && <ListSkeleton />}
      {rows && active.length === 0 && (
        <Card className="py-10 text-center text-sm text-slate-500">
          No client has Google Business Profile connected yet. Note: Business Profile data needs
          Google’s API access approval.
        </Card>
      )}
      {active.length > 0 && (
        <Table
          head={[
            'Client',
            'Profile views',
            'Calls',
            'Directions',
            'Rating',
            'Negative (30d)',
            'Unanswered',
          ]}
          rows={active.map((r) => [
            clientLink(r, 'local'),
            r.gbp?.error ? (
              <span className="text-xs text-red-600" title={r.gbp.error}>
                sync failed
              </span>
            ) : (
              formatNumber(r.gbp?.impressions)
            ),
            <span key="c">
              {formatNumber(r.gbp?.calls)} {r.gbp && <ChangePill pct={r.gbp.callsChangePct} />}
            </span>,
            formatNumber(r.gbp?.directions),
            r.gbp?.rating ? `${r.gbp.rating} ★ (${formatNumber(r.gbp.reviewCount)})` : '—',
            <span key="n" className={(r.reviews?.negative30 ?? 0) > 0 ? 'text-red-700' : ''}>
              {r.reviews?.negative30 ?? '—'}
            </span>,
            r.reviews?.unanswered ?? '—',
          ])}
        />
      )}
      {rows && <NotSetUp rows={rows.filter((r) => !r.gbpSelected)} tab="local" label="Local SEO" />}
    </PageShell>
  );
}

const money = (currency: string | null, n: number | null) =>
  n === null
    ? '—'
    : n.toLocaleString('en-IN', {
        style: 'currency',
        currency: currency || 'INR',
        maximumFractionDigits: 0,
      });

export function AdvertisingPage() {
  const { rows, error } = useOverview();
  const active = rows?.filter((r) => r.adsSelected) ?? [];
  return (
    <PageShell
      title="Advertising"
      intro="Google Ads spend, conversions and wasted spend across clients (last 28 days)."
    >
      {error && <Alert>{error}</Alert>}
      {!rows && !error && <ListSkeleton />}
      {rows && active.length === 0 && (
        <Card className="py-10 text-center text-sm text-slate-500">
          No client has Google Ads connected yet. Reading real Ads accounts needs a developer token
          with Basic Access.
        </Card>
      )}
      {active.length > 0 && (
        <Table
          head={['Client', 'Spend', 'Conversions', 'ROAS', 'Wasted spend', 'Last sync']}
          rows={active.map((r) => [
            clientLink(r, 'ads'),
            r.ads?.error ? (
              <span className="text-xs text-red-600" title={r.ads.error}>
                sync failed
              </span>
            ) : (
              money(r.ads?.currency ?? null, r.ads?.cost ?? null)
            ),
            formatNumber(r.ads?.conversions),
            r.ads?.roas ? `${r.ads.roas}x` : '—',
            <span key="w" className={(r.ads?.wastedSpend ?? 0) > 0 ? 'text-red-700' : ''}>
              {money(r.ads?.currency ?? null, r.ads?.wastedSpend ?? null)}
            </span>,
            r.ads ? formatDateTime(r.ads.runAt) : '—',
          ])}
        />
      )}
      {rows && <NotSetUp rows={rows.filter((r) => !r.adsSelected)} tab="ads" label="Google Ads" />}
    </PageShell>
  );
}

export function YouTubePage() {
  const { rows, error } = useOverview();
  const active = rows?.filter((r) => r.youtubeSelected) ?? [];
  return (
    <PageShell
      title="YouTube"
      intro="Channel views and subscriber growth across clients (last 28 days)."
    >
      {error && <Alert>{error}</Alert>}
      {!rows && !error && <ListSkeleton />}
      {rows && active.length === 0 && (
        <Card className="py-10 text-center text-sm text-slate-500">
          No client has a YouTube channel connected yet.
        </Card>
      )}
      {active.length > 0 && (
        <Table
          head={['Client', 'Views', 'Net subscribers', 'Last sync']}
          rows={active.map((r) => [
            clientLink(r, 'youtube'),
            r.youtube?.error ? (
              <span className="text-xs text-red-600" title={r.youtube.error}>
                sync failed
              </span>
            ) : (
              <span key="v">
                {formatNumber(r.youtube?.views)}{' '}
                {r.youtube && <ChangePill pct={r.youtube.viewsChangePct} />}
              </span>
            ),
            r.youtube?.netSubscribers === null || r.youtube?.netSubscribers === undefined
              ? '—'
              : `${r.youtube.netSubscribers >= 0 ? '+' : ''}${formatNumber(r.youtube.netSubscribers)}`,
            r.youtube ? formatDateTime(r.youtube.runAt) : '—',
          ])}
        />
      )}
      {rows && (
        <NotSetUp rows={rows.filter((r) => !r.youtubeSelected)} tab="youtube" label="YouTube" />
      )}
    </PageShell>
  );
}

export function BillingPage() {
  const [b, setB] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Billing>('/api/billing')
      .then(setB)
      .catch((e: Error) => setError(e.message));
  }, []);
  const bar = (used: number, max: number) => (
    <div
      className="mt-1 h-2 rounded bg-slate-100"
      role="progressbar"
      aria-valuenow={used}
      aria-valuemax={max}
      aria-valuemin={0}
    >
      <div
        className={`h-2 rounded ${used >= max ? 'bg-red-500' : 'bg-[var(--brand)]'}`}
        style={{ width: `${Math.min(100, (used / max) * 100)}%` }}
      />
    </div>
  );
  return (
    <PageShell
      title="Plan & usage"
      intro="Your current plan and limits. Online payments are not enabled yet."
    >
      {error && <Alert>{error}</Alert>}
      {!b && !error && <ListSkeleton rows={2} />}
      {b && (
        <>
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">{b.limits.name} plan</h2>
              <span className="text-sm text-slate-500">
                {b.limits.monthlyPriceInr
                  ? `${formatInr(b.limits.monthlyPriceInr)}/month (indicative)`
                  : 'Free'}
              </span>
            </div>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-slate-500">Clients</dt>
                <dd className="font-medium">
                  {b.usage.clients} / {b.limits.maxClients}
                </dd>
                {bar(b.usage.clients, b.limits.maxClients)}
              </div>
              <div>
                <dt className="text-xs text-slate-500">Team members (incl. pending invites)</dt>
                <dd className="font-medium">
                  {b.usage.members + b.usage.pendingInvites} / {b.limits.maxMembers}
                </dd>
                {bar(b.usage.members + b.usage.pendingInvites, b.limits.maxMembers)}
              </div>
              <div>
                <dt className="text-xs text-slate-500">Manual runs today</dt>
                <dd className="font-medium">
                  {b.usage.manualRunsToday} / {b.limits.manualRunsPerDay}
                </dd>
                {bar(b.usage.manualRunsToday, b.limits.manualRunsPerDay)}
              </div>
            </dl>
          </Card>
          <div className="grid gap-4 md:grid-cols-3">
            {Object.entries(b.plans).map(([id, p]) => (
              <Card key={id} className={id === b.plan ? 'ring-2 ring-[var(--brand)]' : ''}>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="mt-1 text-2xl font-bold">
                  {p.monthlyPriceInr ? formatInr(p.monthlyPriceInr) : '₹0'}
                  <span className="text-sm font-normal text-slate-500">/month</span>
                </p>
                <ul className="mt-3 space-y-1 text-sm text-slate-600">
                  <li>Up to {p.maxClients} clients</li>
                  <li>
                    {p.maxMembers} team member{p.maxMembers > 1 ? 's' : ''}
                  </li>
                  <li>{p.manualRunsPerDay} manual runs/day</li>
                </ul>
                <p className="mt-3 text-xs text-slate-400">
                  {id === b.plan
                    ? 'Current plan'
                    : 'Upgrade by contacting us (payments coming later)'}
                </p>
              </Card>
            ))}
          </div>
          <Alert kind="info">
            Prices are indicative only. No payment provider is connected and nothing is charged.
          </Alert>
        </>
      )}
    </PageShell>
  );
}
