import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useParams } from 'react-router-dom';
import { useConfirm } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { api } from '../lib/api';
import type { ClientDetail } from '../lib/types';

// Same rules as the server (src/routes/clients.ts); the server validates again.
const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(100),
  websiteUrl: z
    .string()
    .trim()
    .url('Enter a full URL like https://example.com')
    .refine((u) => /^https?:\/\//i.test(u), 'URL must start with http:// or https://'),
  contactEmail: z.string().trim().email('Enter a valid email'),
  autoSendReport: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

/** Add a new client (/clients/new) or edit one (/clients/:id/edit). */
export function ClientFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(editing);
  const [serverError, setServerError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', websiteUrl: 'https://', contactEmail: '', autoSendReport: false },
  });

  useEffect(() => {
    if (!id) return;
    api<ClientDetail>(`/api/clients/${id}`)
      .then((d) =>
        reset({
          name: d.client.name,
          websiteUrl: d.client.websiteUrl,
          contactEmail: d.client.contactEmail,
          autoSendReport: d.client.autoSendReport,
        }),
      )
      .catch((e: Error) => setServerError(e.message))
      .finally(() => setLoading(false));
  }, [id, reset]);

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      if (editing) {
        await api(`/api/clients/${id}`, { method: 'PUT', body: values });
        navigate(`/clients/${id}`);
      } else {
        const res = await api<{ client: { id: string } }>('/api/clients', {
          method: 'POST',
          body: values,
        });
        navigate(`/clients/${res.client.id}`);
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${getValues('name')}?`,
      message:
        'This removes all health checks, insights and reports for this client and disconnects their Google account. This cannot be undone.',
      confirmLabel: 'Delete client',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api(`/api/clients/${id}`, { method: 'DELETE' });
      navigate('/clients');
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not delete');
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-xl space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  const err = (k: keyof FormValues) => errors[k]?.message;

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-bold">{editing ? 'Edit client' : 'Add client'}</h1>
      <Card>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Field label="Client / business name" error={err('name')}>
            <input
              className={inputClass}
              {...register('name')}
              autoFocus
              aria-invalid={Boolean(err('name'))}
            />
          </Field>
          <Field
            label="Website URL"
            hint="The page PageSpeed will test, usually the home page."
            error={err('websiteUrl')}
          >
            <input
              className={inputClass}
              type="url"
              {...register('websiteUrl')}
              aria-invalid={Boolean(err('websiteUrl'))}
            />
          </Field>
          <Field
            label="Client's email"
            hint="Monthly reports are emailed here."
            error={err('contactEmail')}
          >
            <input
              className={inputClass}
              type="email"
              {...register('contactEmail')}
              aria-invalid={Boolean(err('contactEmail'))}
            />
          </Field>
          <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
            <input type="checkbox" className="mt-1 h-4 w-4" {...register('autoSendReport')} />
            <span>
              <span className="block text-sm font-medium">Auto-send monthly report</span>
              <span className="block text-xs text-slate-500">
                On the 1st of every month the report is emailed automatically. If off, it is
                prepared for you to preview and send manually.
              </span>
            </span>
          </label>
          {serverError && <Alert>{serverError}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={isSubmitting}>
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
