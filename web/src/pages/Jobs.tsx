import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../components/badges';
import { Alert, Button, Card, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ClientListItem, JobRun } from '../lib/types';

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
