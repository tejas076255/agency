import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../components/badges';
import { Alert, Button, Card, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ClientListItem, JobRun, UsageRow } from '../lib/types';

const API_LABEL: Record<string, string> = {
  gsc: 'Search Console',
  ga4: 'GA4 Data',
  ga4_admin: 'GA4 Admin',
  pagespeed: 'PageSpeed',
  slides: 'Slides',
  drive: 'Drive',
  gmail: 'Gmail',
  oauth: 'Google OAuth',
  workers_ai: 'Workers AI',
  other: 'Other',
};

/** API calls per service over the last 7 days (quota/cost monitoring). */
function UsageCard() {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  useEffect(() => {
    api<{ usage: UsageRow[] }>('/api/agency/usage')
      .then((r) => setRows(r.usage))
      .catch(() => setRows([]));
  }, []);
  if (!rows) return null;
  const totals = new Map<string, { calls: number; errors: number; quotaErrors: number }>();
  for (const r of rows) {
    const t = totals.get(r.api) ?? { calls: 0, errors: 0, quotaErrors: 0 };
    t.calls += r.calls;
    t.errors += r.errors;
    t.quotaErrors += r.quotaErrors;
    totals.set(r.api, t);
  }
  const quotaHit = [...totals.values()].some((t) => t.quotaErrors > 0);
  return (
    <Card>
      <h2 className="font-semibold">API usage (last 7 days)</h2>
      <p className="text-sm text-slate-500">
        Counts every call to Google APIs and Workers AI made for your agency.
      </p>
      {quotaHit && (
        <div className="mt-3">
          <Alert>
            ⚠ Some calls hit a quota limit (HTTP 429). Jobs retry automatically; if this keeps
            happening, reduce manual runs or request a higher quota in Google Cloud.
          </Alert>
        </div>
      )}
      {totals.size === 0 ? (
        <p className="py-4 text-sm text-slate-400">No API calls recorded yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th scope="col" className="py-2 font-medium">
                  API
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Calls
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Errors
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Quota errors
                </th>
              </tr>
            </thead>
            <tbody>
              {[...totals.entries()].map(([api, t]) => (
                <tr key={api} className="border-b border-slate-100 last:border-0">
                  <td className="py-2">{API_LABEL[api] ?? api}</td>
                  <td className="py-2 text-right tabular-nums">
                    {t.calls.toLocaleString('en-IN')}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {t.errors.toLocaleString('en-IN')}
                  </td>
                  <td
                    className={`py-2 text-right tabular-nums ${t.quotaErrors ? 'text-red-700' : ''}`}
                  >
                    {t.quotaErrors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function JobsPage() {
  const [jobs, setJobs] = useState<JobRun[] | null>(null);
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, c] = await Promise.all([
        api<{ jobs: JobRun[] }>('/api/jobs'),
        api<{ clients: ClientListItem[] }>('/api/clients'),
      ]);
      setJobs(j.jobs);
      setClients(c.clients);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000); // live-ish updates
    return () => clearInterval(t);
  }, [load]);

  async function runNow(clientId: string) {
    setBusy(clientId);
    setMessage(null);
    try {
      await api(`/api/clients/${clientId}/run`, { method: 'POST', body: { type: 'health_check' } });
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const running = new Set(
    (jobs ?? [])
      .filter((j) => j.status === 'queued' || j.status === 'running')
      .map((j) => j.clientId),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Job logs</h1>
        <p className="text-sm text-slate-500">
          Health checks run every Monday at 6:00 AM IST; reports on the 1st at 6:00 AM IST. Updates
          every 10 seconds.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {message && <Alert>{message}</Alert>}

      {clients.length > 0 && (
        <Card>
          <h2 className="mb-3 font-semibold">Run a health check now</h2>
          <ul className="divide-y divide-slate-100">
            {clients.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <Link
                  to={`/clients/${c.id}`}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {c.name}
                </Link>
                <Button
                  variant="secondary"
                  loading={busy === c.id || running.has(c.id)}
                  onClick={() => void runNow(c.id)}
                >
                  {running.has(c.id) ? 'Running…' : 'Run now'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <UsageCard />

      <Card className="p-0">
        <h2 className="px-5 pt-5 font-semibold">Recent jobs</h2>
        {jobs === null ? (
          <Spinner />
        ) : jobs.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-400">
            No jobs yet. Use "Run now" above or wait for the Monday check.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-y border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="whitespace-nowrap px-5 py-2 text-slate-600">
                      {formatDateTime(j.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <Link to={`/clients/${j.clientId}`} className="hover:underline">
                        {j.clientName}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {j.type === 'health_check' ? 'Health check' : 'Monthly report'}
                      <span className="ml-1 text-xs text-slate-400">({j.trigger})</span>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="max-w-md px-5 py-2 text-xs text-slate-600">
                      {j.error ??
                        (j.finishedAt && j.startedAt
                          ? `Took ${Math.round((j.finishedAt - j.startedAt) / 1000)} s`
                          : '')}
                      {j.attempt > 1 && (
                        <span className="ml-1 text-slate-400">(attempt {j.attempt})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
