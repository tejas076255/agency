import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogoUploader } from '../components/LogoUploader';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { api, type Agency } from '../lib/api';
import { useAuth } from '../lib/auth';

export function OnboardingPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4f46e5');
  const [agency, setAgency] = useState<Agency | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createAgency(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ agency: Agency }>('/api/agency', {
        method: 'POST',
        body: { name, brandColor: color },
      });
      setAgency(res.agency);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create agency');
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    await refresh();
    navigate('/dashboard', { replace: true });
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ ['--brand' as string]: color }}
    >
      <Card className="w-full max-w-md">
        <p className="text-sm text-slate-500">Welcome, {me?.user?.name}</p>
        <h1 className="mt-1 text-xl font-bold">
          {agency ? 'Add your logo (optional)' : 'Set up your agency'}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {agency
            ? 'Your logo appears on client reports. You can change it later in Settings.'
            : 'This name and color will appear on the reports your clients receive.'}
        </p>

        {!agency ? (
          <form onSubmit={createAgency} className="mt-6 space-y-4">
            <Field label="Agency name">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Growth Pixel Digital"
                minLength={2}
                maxLength={80}
                required
                autoFocus
              />
            </Field>
            <Field label="Brand color">
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-10 w-14 cursor-pointer rounded border border-slate-300"
                />
                <span className="font-mono text-sm text-slate-600">{color}</span>
              </div>
            </Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" loading={saving} className="w-full">
              Continue
            </Button>
          </form>
        ) : (
          <div className="mt-6 space-y-6">
            <LogoUploader agency={agency} onChange={setAgency} />
            <Button onClick={finish} className="w-full">
              {agency.logoUrl ? 'Go to dashboard' : 'Skip for now'}
            </Button>
          </div>
        )}
      </Card>
    </main>
  );
}
