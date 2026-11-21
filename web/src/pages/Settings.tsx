import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useConfirm } from '../components/ConfirmDialog';
import { LogoUploader } from '../components/LogoUploader';
import { Skeleton } from '../components/Skeleton';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { api, setCsrfToken, type Agency } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { AuditLogRow, ReportSettings } from '../lib/types';

type Msg = { kind: 'success' | 'error'; text: string } | null;

export function SettingsPage() {
  const { me, refresh } = useAuth();
  const agency = me?.agency;
  const isOwner = me?.user?.role === 'owner';
  if (!agency) return null;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      {!isOwner && <Alert kind="info">Only the agency owner can change these settings.</Alert>}
      <BrandingForm agency={agency} isOwner={isOwner} onSaved={refresh} />
      {isOwner && (
        <Card>
          <h2 className="mb-4 font-semibold">Logo</h2>
          <LogoUploader agency={agency} onChange={() => void refresh()} />
        </Card>
      )}
      <WorkspaceCard isOwner={isOwner} />
      <ReportSettingsForm isOwner={isOwner} />
      <AccountCard />
      {isOwner && <AuditLogCard />}
    </div>
  );
}

const brandingSchema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(80),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #4f46e5'),
});
type BrandingValues = z.infer<typeof brandingSchema>;

function BrandingForm({
  agency,
  isOwner,
  onSaved,
}: {
  agency: Agency;
  isOwner: boolean;
  onSaved: () => Promise<void>;
}) {
  const [msg, setMsg] = useState<Msg>(null);
  const { register, handleSubmit, watch, reset, formState } = useForm<BrandingValues>({
    resolver: zodResolver(brandingSchema),
    defaultValues: { name: agency.name, brandColor: agency.brandColor },
  });
  useEffect(() => reset({ name: agency.name, brandColor: agency.brandColor }), [agency, reset]);

  async function onSubmit(values: BrandingValues) {
    setMsg(null);
    try {
      await api('/api/agency', { method: 'PUT', body: values });
      await onSaved();
      setMsg({ kind: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  }

  return (
    <Card>
      <h2 className="mb-4 font-semibold">Agency branding</h2>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field label="Agency name" error={formState.errors.name?.message}>
          <input className={inputClass} {...register('name')} disabled={!isOwner} />
        </Field>
        <Field
          label="Brand color"
          hint="Used on reports and across the app."
          error={formState.errors.brandColor?.message}
        >
          <div className="flex items-center gap-3">
            <input
              type="color"
              {...register('brandColor')}
              disabled={!isOwner}
              className="h-10 w-14 cursor-pointer rounded border border-slate-300"
            />
            <span className="font-mono text-sm text-slate-600">{watch('brandColor')}</span>
          </div>
        </Field>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {isOwner && (
          <Button type="submit" loading={formState.isSubmitting}>
            Save changes
          </Button>
        )}
      </form>
    </Card>
  );
}

const reportSchema = z.object({
  emailSubject: z.string().trim().min(3, 'Too short').max(150),
  emailMessage: z.string().trim().min(3, 'Too short').max(1000),
  ccAgency: z.boolean(),
  includeHinglish: z.boolean(),
});

function ReportSettingsForm({ isOwner }: { isOwner: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const { register, handleSubmit, reset, formState } = useForm<ReportSettings>({
    resolver: zodResolver(reportSchema),
  });

  useEffect(() => {
    api<{ settings: ReportSettings }>('/api/agency/report-settings')
      .then((r) => reset(r.settings))
      .catch((e: Error) => setMsg({ kind: 'error', text: e.message }))
      .finally(() => setLoaded(true));
  }, [reset]);

  async function onSubmit(values: ReportSettings) {
    setMsg(null);
    try {
      await api('/api/agency/report-settings', { method: 'PUT', body: values });
      setMsg({ kind: 'success', text: 'Report email settings saved.' });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  }

  return (
    <Card>
      <h2 className="font-semibold">Report email</h2>
      <p className="mb-4 text-sm text-slate-500">
        Used for every monthly report email. Placeholders: <code>{'{client}'}</code>,{' '}
        <code>{'{month}'}</code>, <code>{'{agency}'}</code>.
      </p>
      {!loaded ? (
        <Skeleton className="h-40" />
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Field label="Subject" error={formState.errors.emailSubject?.message}>
            <input className={inputClass} {...register('emailSubject')} disabled={!isOwner} />
          </Field>
          <Field label="Message" error={formState.errors.emailMessage?.message}>
            <textarea
              className={`${inputClass} min-h-24`}
              {...register('emailMessage')}
              disabled={!isOwner}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...register('ccAgency')}
              disabled={!isOwner}
            />
            CC the agency Gmail account on every report email
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              {...register('includeHinglish')}
              disabled={!isOwner}
            />
            Include the Hinglish summary in the email
          </label>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          {isOwner && (
            <Button type="submit" loading={formState.isSubmitting}>
              Save report settings
            </Button>
          )}
        </form>
      )}
    </Card>
  );
}

function AccountCard() {
  const { me } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function logoutAll() {
    const ok = await confirm({
      title: 'Log out of all devices?',
      message: 'You will be signed out everywhere, including this browser.',
      confirmLabel: 'Log out everywhere',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await api('/auth/logout-all', { method: 'POST' }).catch(() => undefined);
    setCsrfToken(null);
    navigate('/login', { replace: true });
    window.location.reload();
  }

  return (
    <Card>
      <h2 className="mb-2 font-semibold">Your account</h2>
      <p className="text-sm text-slate-600">
        {me?.user?.name} · {me?.user?.email} · <span className="capitalize">{me?.user?.role}</span>
      </p>
      <Button variant="secondary" className="mt-4" loading={busy} onClick={logoutAll}>
        Log out of all devices
      </Button>
    </Card>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.logout_all': 'Logged out of all devices',
  'agency.create': 'Created the agency',
  'agency.update': 'Updated agency branding',
  'agency.logo_update': 'Uploaded a logo',
  'agency.logo_delete': 'Removed the logo',
  'agency.report_settings_update': 'Changed report email settings',
  'client.create': 'Added a client',
  'client.update': 'Edited a client',
  'client.delete': 'Deleted a client',
  'client.sources_update': 'Changed Search Console / GA4 selection',
  'google.client_connect': 'Connected a client Google account',
  'google.client_disconnect': 'Disconnected a client Google account',
  'google.workspace_connect': 'Connected the agency Google account',
  'google.workspace_disconnect': 'Disconnected the agency Google account',
  'job.run_requested': 'Started a job manually',
  'report.pdf_refresh': 'Re-exported a report PDF',
  'report.send': 'Emailed a report',
};

function AuditLogCard() {
  const [logs, setLogs] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ logs: AuditLogRow[] }>('/api/agency/audit-logs')
      .then((r) => setLogs(r.logs))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Card className="p-0">
      <div className="px-5 pt-5">
        <h2 className="font-semibold">Activity log</h2>
        <p className="text-sm text-slate-500">
          Last 200 actions in your agency (only visible to the owner).
        </p>
      </div>
      {error && (
        <div className="p-5">
          <Alert>{error}</Alert>
        </div>
      )}
      {!logs && !error && (
        <div className="p-5">
          <Skeleton className="h-32" />
        </div>
      )}
      {logs && logs.length === 0 && <p className="p-5 text-sm text-slate-400">No activity yet.</p>}
      {logs && logs.length > 0 && (
        <ul className="mt-3 max-h-96 divide-y divide-slate-100 overflow-y-auto">
          {logs.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2 text-sm"
            >
              <span>
                <b className="font-medium">{l.userName ?? 'System'}</b>{' '}
                {ACTION_LABEL[l.action] ?? l.action}
                {typeof l.metadata?.name === 'string' && (
                  <span className="text-slate-500"> · {l.metadata.name}</span>
                )}
              </span>
              <span className="text-xs text-slate-400">{formatDateTime(l.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
