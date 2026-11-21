import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Button, Card, Spinner } from './ui';

type Workspace = {
  connection: { googleEmail: string; status: 'active' | 'revoked'; connectedAt: number } | null;
};

const ERRORS: Record<string, string> = {
  missing_scopes:
    'Please allow all three permissions (Slides, Drive files created by this app, and Send email).',
  no_refresh_token: 'Google did not give long-term access. Please try again.',
  owner_only: 'Only the agency owner can connect the agency Google account.',
  google_error: 'Google connection failed. Please try again.',
};

/** Agency's own Google account: used to build reports in Slides and email them from Gmail. */
export function WorkspaceCard({ isOwner }: { isOwner: boolean }) {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(
    () =>
      api<Workspace>('/api/agency/google')
        .then(setData)
        .catch(() => setData({ connection: null })),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (params.get('connected'))
      setMsg({
        kind: 'success',
        text: 'Agency Google account connected. Reports can now be created and emailed.',
      });
    const e = params.get('connect_error');
    if (e) setMsg({ kind: 'error', text: ERRORS[e] ?? 'Connection failed.' });
    if (params.get('connected') || e) setParams({}, { replace: true });
  }, [params, setParams]);

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/api/agency/google/connect', { method: 'POST' });
      window.location.href = url;
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect? Monthly reports cannot be created or emailed until you reconnect.'))
      return;
    setBusy(true);
    await api('/api/agency/google', { method: 'DELETE' }).catch(() => undefined);
    await load();
    setBusy(false);
  }

  const conn = data?.connection;
  return (
    <Card>
      <h2 className="font-semibold">Reports: agency Google account</h2>
      <p className="mt-1 text-sm text-slate-500">
        Reports are built in Google Slides in your Drive, exported to PDF and emailed to clients
        from your own Gmail. The app can only see files it creates.
      </p>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <div className="mt-4">
        {data === null ? (
          <Spinner />
        ) : conn && conn.status === 'active' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="text-green-700">● Connected</span> as <b>{conn.googleEmail}</b>
              <span className="block text-xs text-slate-500">
                since {formatDateTime(conn.connectedAt)}
              </span>
            </p>
            {isOwner && (
              <Button variant="danger" loading={busy} onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              {conn?.status === 'revoked' ? (
                <span className="text-red-700">⚠ Access was revoked. Please reconnect.</span>
              ) : (
                'Not connected yet.'
              )}
            </p>
            {isOwner ? (
              <Button loading={busy} onClick={connect}>
                {conn ? 'Reconnect' : 'Connect Google account'}
              </Button>
            ) : (
              <span className="text-xs text-slate-500">Ask the agency owner to connect.</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
