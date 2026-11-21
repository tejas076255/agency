import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '../components/badges';
import { ListSkeleton } from '../components/Skeleton';
import { Alert, Card } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, formatMonth } from '../lib/format';
import type { ReportListItem } from '../lib/types';

/** Report history across all clients. Sending/editing happens on the client page. */
export function ReportsPage() {
  const [reports, setReports] = useState<ReportListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | 'sent' | 'failed'>('all');

  useEffect(() => {
    api<{ reports: ReportListItem[] }>('/api/reports')
      .then((r) => setReports(r.reports))
      .catch((e: Error) => setError(e.message));
  }, []);

  const shown = reports?.filter((r) => filter === 'all' || r.status === filter) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-sm text-slate-500">
          Monthly reports are prepared on the 1st at 6:00 AM IST. Open a client to preview, edit and
          send.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter reports">
        {(['all', 'ready', 'sent', 'failed'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-sm ${
              filter === f
                ? 'bg-[var(--brand)] text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200'
            }`}
          >
            {f === 'all'
              ? 'All'
              : f === 'ready'
                ? 'Ready to send'
                : f === 'sent'
                  ? 'Sent'
                  : 'Failed'}
          </button>
        ))}
      </div>

      {shown === null && !error && <ListSkeleton rows={3} />}
      {shown && shown.length === 0 && (
        <Card className="py-10 text-center text-sm text-slate-400">No reports here yet.</Card>
      )}
      {shown && shown.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {shown.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/clients/${r.clientId}`} className="font-medium hover:underline">
                      {r.clientName}
                    </Link>
                    <span className="text-sm text-slate-500">{formatMonth(r.month)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="text-xs text-slate-500">
                    Created {formatDateTime(r.createdAt)}
                    {r.sentAt && ` · sent ${formatDateTime(r.sentAt)}`}
                  </div>
                  {r.error && <div className="mt-1 text-xs text-red-600">{r.error}</div>}
                </div>
                {(r.status === 'ready' || r.status === 'sent') && (
                  <div className="flex gap-3 text-sm">
                    <a
                      href={`/api/reports/${r.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--brand)] hover:underline"
                    >
                      PDF
                    </a>
                    <a
                      href={r.shareUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--brand)] hover:underline"
                    >
                      Share page
                    </a>
                    <Link
                      to={`/clients/${r.clientId}`}
                      className="text-[var(--brand)] hover:underline"
                    >
                      {r.status === 'ready' ? 'Review & send' : 'Open'}
                    </Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
