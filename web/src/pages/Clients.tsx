import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClientStatusBadge, ScoreBadge, TrendArrow } from '../components/badges';
import { ListSkeleton } from '../components/Skeleton';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { ClientListItem } from '../lib/types';

export function ClientsPage() {
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api<{ clients: ClientListItem[] }>('/api/clients')
      .then((r) => setClients(r.clients))
      .catch((e: Error) => setError(e.message));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!clients || !q) return clients;
    return clients.filter(
      (c) => c.name.toLowerCase().includes(q) || c.websiteUrl.toLowerCase().includes(q),
    );
  }, [clients, query]);

  const reconnect = clients?.filter((c) => c.status === 'reconnect_needed') ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold">Clients</h1>
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

      {clients === null && !error && <ListSkeleton />}

      {clients && clients.length === 0 && (
        <Card className="py-12 text-center">
          <h2 className="font-semibold">No clients yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Add a client, connect their Google account and run the first health check.
          </p>
          <Link to="/clients/new" className="mt-4 inline-block">
            <Button>+ Add your first client</Button>
          </Link>
        </Card>
      )}

      {clients && clients.length > 0 && (
        <>
          <label className="block max-w-sm">
            <span className="sr-only">Search clients</span>
            <input
              className={inputClass}
              placeholder="Search by name or website…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Card className="p-0">
            {filtered && filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">No clients match “{query}”.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {filtered?.map((c) => (
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
                          {c.profileScore !== null && (
                            <span
                              className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700"
                              title="Google Business Profile score"
                            >
                              Profile {c.profileScore}/100
                            </span>
                          )}
                          {c.fixesReady > 0 && (
                            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                              ✨ {c.fixesReady} fix{c.fixesReady > 1 ? 'es' : ''} ready
                            </span>
                          )}
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
            )}
          </Card>
        </>
      )}
    </div>
  );
}
