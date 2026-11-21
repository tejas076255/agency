import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, Field, inputClass, Spinner } from '../components/ui';
import { api } from '../lib/api';
import type { ClientDetail } from '../lib/types';

/** Add a new client (/clients/new) or edit one (/clients/:id/edit). */
export function ClientFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [loading, setLoading] = useState(editing);
  const [form, setForm] = useState({
    name: '',
    websiteUrl: 'https://',
    contactEmail: '',
    autoSendReport: false,
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<ClientDetail>(`/api/clients/${id}`)
      .then((d) =>
        setForm({
          name: d.client.name,
          websiteUrl: d.client.websiteUrl,
          contactEmail: d.client.contactEmail,
          autoSendReport: d.client.autoSendReport,
        }),
      )
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/clients/${id}`, { method: 'PUT', body: form });
        navigate(`/clients/${id}`);
      } else {
        const res = await api<{ client: { id: string } }>('/api/clients', {
          method: 'POST',
          body: form,
        });
        navigate(`/clients/${res.client.id}?new=1`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (
      !confirm(
        `Delete ${form.name}? This removes all health checks, insights and reports for this client.`,
      )
    )
      return;
    setDeleting(true);
    try {
      await api(`/api/clients/${id}`, { method: 'DELETE' });
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
      setDeleting(false);
    }
  }

  if (loading) return <Spinner />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">{editing ? 'Edit client' : 'Add client'}</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Client / business name">
            <input
              className={inputClass}
              value={form.name}
              onChange={set('name')}
              required
              minLength={2}
              maxLength={100}
              autoFocus
            />
          </Field>
          <Field label="Website URL" hint="The page PageSpeed will test, usually the home page.">
            <input
              className={inputClass}
              type="url"
              value={form.websiteUrl}
              onChange={set('websiteUrl')}
              required
            />
          </Field>
          <Field label="Client's email" hint="Monthly reports are emailed here.">
            <input
              className={inputClass}
              type="email"
              value={form.contactEmail}
              onChange={set('contactEmail')}
              required
            />
          </Field>
          <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={form.autoSendReport}
              onChange={set('autoSendReport')}
            />
            <span>
              <span className="block text-sm font-medium">Auto-send monthly report</span>
              <span className="block text-xs text-slate-500">
                On the 1st of every month the report is emailed automatically. If off, it is
                prepared for you to preview and send manually.
              </span>
            </span>
          </label>
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={saving}>
              {editing ? 'Save changes' : 'Add client'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
      {editing && (
        <Card>
          <h2 className="font-semibold text-red-700">Delete client</h2>
          <p className="mt-1 text-sm text-slate-500">Also disconnects their Google account.</p>
          <Button variant="danger" className="mt-3" loading={deleting} onClick={remove}>
            Delete client
          </Button>
        </Card>
      )}
    </div>
  );
}
