import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { LogoUploader } from '../components/LogoUploader';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { api, type Agency } from '../lib/api';
import { useAuth } from '../lib/auth';

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(80),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #4f46e5'),
});
type Values = z.infer<typeof schema>;

export function OnboardingPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [agency, setAgency] = useState<Agency | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, watch, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', brandColor: '#4f46e5' },
  });
  const color = watch('brandColor');

  async function onSubmit(values: Values) {
    setServerError(null);
    try {
      const res = await api<{ agency: Agency }>('/api/agency', { method: 'POST', body: values });
      setAgency(res.agency);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not create agency');
    }
  }

  async function finish() {
    await refresh();
    navigate('/dashboard', { replace: true });
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ ['--brand' as string]: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f46e5' }}
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
          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
            <Field label="Agency name" error={formState.errors.name?.message}>
              <input
                className={inputClass}
                {...register('name')}
                placeholder="e.g. Growth Pixel Digital"
                autoFocus
              />
            </Field>
            <Field label="Brand color" error={formState.errors.brandColor?.message}>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  {...register('brandColor')}
                  className="h-10 w-14 cursor-pointer rounded border border-slate-300"
                />
                <span className="font-mono text-sm text-slate-600">{color}</span>
              </div>
            </Field>
            {serverError && <Alert>{serverError}</Alert>}
            <Button type="submit" loading={formState.isSubmitting} className="w-full">
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
