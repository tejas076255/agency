import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScoreBadge, StatusBadge } from '../components/badges';
import { CardsSkeleton, ListSkeleton } from '../components/Skeleton';
import { Alert, Button, Card } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatMonth } from '../lib/format';
import type { ClientListItem, JobRun, ReportListItem } from '../lib/types';

type Attention = { client: ClientListItem; reason: string; tone: 'red' | 'amber' };

/** Overview: agency-wide numbers and the things that need attention today. */
export function DashboardPage() {
  const { me } = useAuth();
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [jobs, setJobs] = useState<JobRun[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ clients: ClientListItem[] }>('/api/clients'),
      api<{ jobs: JobRun[] }>('/api/jobs'),
      api<{ reports: ReportListItem[] }>('/api/reports'),
    ])
      .then(([c, j, r]) => {
        setClients(c.clients);
        setJobs(j.jobs);
        setReports(r.reports);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const firstName = me?.user?.name?.split(' ')[0];

  if (error) return <Alert>{error}</Alert>;
  if (!clients) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <CardsSkeleton />
        <ListSkeleton rows={3} />
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Welcome, {firstName} 👋</h1>
        <Card className="py-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--brand)]/10 text-2xl">
            📊
          </div>
          <h2 className="font-semibold">Add your first client</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Connect their Google account and get a health score, 5 action items and a monthly report
            on autopilot.
          </p>
          <Link to="/clients/new" className="mt-4 inline-block">
            <Button>+ Add client</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const scored = clients.filter((c) => c.score !== null);
  const avg = scored.length
    ? Math.round(scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length)
    : null;
  const toSend = reports.filter((r) => r.status === 'ready');

  const attention: Attention[] = [];
  for (const c of clients) {
    if (c.status === 'reconnect_needed')
      attention.push({ client: c, reason: 'Google access expired: reconnect needed', tone: 'red' });
    else if (c.status === 'not_connected')
      attention.push({ client: c, reason: 'Google account not connected', tone: 'amber' });
    else if (!c.sourcesSelected)
      attention.push({
        client: c,
        reason: 'Pick Search Console site / GA4 property',
        tone: 'amber',
      });
    if (c.score !== null && c.score < 50)
      attention.push({ client: c, reason: `Low health score (${c.score}/100)`, tone: 'red' });
    if (c.score !== null && c.previousScore !== null && c.score - c.previousScore <= -10) {
      attention.push({
        client: c,
        reason: `Score dropped ${c.previousScore - c.score} points`,
        tone: 'red',
      });
    }
  }
  const failedJobs = jobs.filter((j) => j.status === 'failed').slice(0, 3);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-slate-500">Welcome back, {firstName}.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Clients" value={String(clients.length)} to="/clients" />
        <Tile label="Average health score" value={avg === null ? '—' : String(avg)} />
        <Tile
          label="Need attention"
          value={String(new Set(attention.map((a) => a.client.id)).size)}
        />
        <Tile label="Reports ready to send" value={String(toSend.length)} to="/reports" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold">Needs attention</h2>
          {attention.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">All clients look good ✓</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {attention.slice(0, 8).map((a, i) => (
                <li key={`${a.client.id}-${i}`} className="flex items-center gap-3 py-2">
                  <ScoreBadge score={a.client.score} />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/clients/${a.client.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {a.client.name}
                    </Link>
                    <span
                      className={`text-xs ${a.tone === 'red' ? 'text-red-700' : 'text-amber-700'}`}
                    >
                      ⚠ {a.reason}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Recent activity</h2>
            <Link to="/jobs" className="text-sm text-[var(--brand)] hover:underline">
              All job logs
            </Link>
          </div>
          {jobs.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              No jobs yet. Health checks run every Monday 6:00 AM IST.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {jobs.slice(0, 6).map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{j.clientName}</div>
                    <div className="text-xs text-slate-500">
                      {j.type === 'health_check' ? 'Health check' : 'Monthly report'} ·{' '}
                      {formatDateTime(j.createdAt)}
                    </div>
                  </div>
                  <StatusBadge status={j.status} />
                </li>
              ))}
            </ul>
          )}
          {failedJobs.length > 0 && (
            <p className="mt-3 text-xs text-red-700">
              {failedJobs.length} recent job(s) failed. Check Job logs for details.
            </p>
          )}
        </Card>
      </div>

      {toSend.length > 0 && (
        <Card>
          <h2 className="font-semibold">Reports waiting for your review</h2>
          <ul className="mt-3 divide-y divide-slate-100">
            {toSend.slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <b>{r.clientName}</b> · {formatMonth(r.month)}
                </span>
                <Link to={`/clients/${r.clientId}`} className="text-[var(--brand)] hover:underline">
                  Review & send
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Tile({ label, value, to }: { label: string; value: string; to?: string }) {
  const body = (
    <Card className="p-4 transition hover:shadow-md">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}
