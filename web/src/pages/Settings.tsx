import { useEffect, useState, type FormEvent } from 'react';
import { LogoUploader } from '../components/LogoUploader';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { api, type Agency } from '../lib/api';
import { useAuth } from '../lib/auth';

export function SettingsPage() {
  const { me, refresh } = useAuth();
  const agency = me?.agency;
  const isOwner = me?.user?.role === 'owner';
  const [name, setName] = useState(agency?.name ?? '');
  const [color, setColor] = useState(agency?.brandColor ?? '#4f46e5');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (agency) {
      setName(agency.name);
      setColor(agency.brandColor);
    }
  }, [agency]);

  if (!agency) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api<{ agency: Agency }>('/api/agency', {
        method: 'PUT',
        body: { name, brandColor: color },
      });
      await refresh();
      setMessage({ kind: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {!isOwner && <Alert kind="info">Only the agency owner can change these settings.</Alert>}

      <Card>
        <h2 className="mb-4 font-semibold">Agency branding</h2>
        <form onSubmit={save} className="space-y-4">
          <Field label="Agency name">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={80}
              required
              disabled={!isOwner}
            />
          </Field>
          <Field label="Brand color" hint="Used on reports and across the app.">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                disabled={!isOwner}
                className="h-10 w-14 cursor-pointer rounded border border-slate-300"
              />
              <span className="font-mono text-sm text-slate-600">{color}</span>
            </div>
          </Field>
          {message && <Alert kind={message.kind}>{message.text}</Alert>}
          {isOwner && (
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          )}
        </form>
      </Card>

      <WorkspaceCard isOwner={isOwner} />

      {isOwner && (
        <Card>
          <h2 className="mb-4 font-semibold">Logo</h2>
          <LogoUploader agency={agency} onChange={() => void refresh()} />
        </Card>
      )}

      <Card>
        <h2 className="mb-2 font-semibold">Your account</h2>
        <p className="text-sm text-slate-600">
          {me?.user?.name} · {me?.user?.email} ·{' '}
          <span className="capitalize">{me?.user?.role}</span>
        </p>
      </Card>
    </div>
  );
}
