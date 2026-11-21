import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClientStatusBadge, ScoreBadge, TrendArrow } from '../components/badges';
import { Alert, Button, Card, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import type { ClientListItem } from '../lib/types';

export function DashboardPage() {
  const { me } = useAuth();
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ clients: ClientListItem[] }>('/api/clients');
      setClients(res.clients);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load clients');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reconnect = clients?.filter((c) => c.status === 'reconnect_needed') ?? [];
  const scored = clients?.filter((c) => c.score !== null) ?? [];
  const avg = scored.length
    ? Math.round(scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Clients</h1>
          <p className="text-sm text-slate-500">Welcome back, {me?.user?.name?.split(' ')[0]}.</p>
        </div>
        <Link to="/clients/new">
          <Button>+ Add client</Button>
        </Link>
      </div>

      {error && <Alert>{error}</Alert>}

      {reconnect.length > 0 && (
        <Alert>
          ⚠ {reconnect.length} client{reconnect.length > 1 ? 's need' : ' needs'} the Google account
          reconnected:{' '}
          {reconnect.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ', '}
              <Link to={`/clients/${c.id}`} className="font-medium underline">
                {c.name}
              </Link>
            </span>
          ))}
        </Alert>
      )}

      {clients === null && !error && <Spinner label="Loading clients…" />}

      {clients && clients.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <div className="text-xs text-slate-500">Clients</div>
            <div className="text-2xl font-bold">{clients.length}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-slate-500">Average health score</div>
            <div className="text-2xl font-bold">{avg ?? '—'}</div>
          </Card>
          <Card className="col-span-2 p-4 sm:col-span-1">
            <div className="text-xs text-slate-500">Need attention</div>
            <div className="text-2xl font-bold">
              {
                clients.filter((c) => c.status !== 'active' || (c.score !== null && c.score < 50))
                  .length
              }
            </div>
          </Card>
        </div>
      )}

      {clients && clients.length === 0 && (
        <Card className="py-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--brand)]/10 text-2xl">
            📊
          </div>
          <h2 className="font-semibold">No clients yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Add your first client, connect their Google account, and get a health score with 5
            action items.
          </p>
          <Link to="/clients/new" className="mt-4 inline-block">
            <Button>+ Add your first client</Button>
          </Link>
        </Card>
      )}

      {clients && clients.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {clients.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/clients/${c.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50"
                >
                  <ScoreBadge score={c.score} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      <ClientStatusBadge status={c.status} />
                      {c.status === 'active' && !c.sourcesSelected && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                          ⚠ Pick data sources
                        </span>
                      )}
                    </div>
                    <div className="truncate text-sm text-slate-500">
                      {c.websiteUrl.replace(/^https?:\/\//, '')}
                    </div>
                  </div>
                  <div className="hidden text-right sm:block">
                    <TrendArrow current={c.score} previous={c.previousScore} />
                    <div className="text-xs text-slate-400">
                      checked {relativeTime(c.lastRunAt)}
                    </div>
                  </div>
                  <span className="text-slate-300" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
