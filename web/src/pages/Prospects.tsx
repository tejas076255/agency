// Prospect audits (lead generation): enter a prospect's website, get a branded free audit written by
// AI from measured checks (PageSpeed + on-page SEO). "Download PDF" uses the browser's print dialog.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ScoreBadge } from '../components/badges';
import { useConfirm } from '../components/ConfirmDialog';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { AiLanguage, ProspectAudit } from '../lib/types';

export function ProspectsPage() {
  const { auditId } = useParams();
  return auditId ? <AuditView id={auditId} /> : <AuditList />;
}

function AuditList() {
  const navigate = useNavigate();
  const [audits, setAudits] = useState<ProspectAudit[] | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ audits: ProspectAudit[] }>('/api/prospects')
      .then((r) => setAudits(r.audits))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ audit: ProspectAudit }>('/api/prospects', {
        method: 'POST',
        body: { url, businessName: name || undefined, language },
      });
      navigate(`/prospects/${r.audit.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Prospect audits</h1>
        <p className="text-sm text-slate-500">
          Win new clients: run a free website audit for any business, then send them the branded
          PDF.
        </p>
      </div>
      <Card>
        <form
          className="grid gap-3 md:grid-cols-[2fr_1.5fr_auto_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input
            className={inputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Prospect website, e.g. example.in"
            maxLength={300}
            aria-label="Prospect website"
          />
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Business name (optional)"
            maxLength={120}
            aria-label="Business name"
          />
          <select
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value as AiLanguage)}
            aria-label="Report language"
          >
            <option value="en">English</option>
            <option value="hinglish">Hinglish</option>
            <option value="hi">Hindi</option>
          </select>
          <Button type="submit" loading={busy} disabled={url.trim().length < 4}>
            Run audit
          </Button>
        </form>
        {busy && (
          <p className="mt-2 text-xs text-slate-500">
            Checking speed (mobile + desktop), SEO tags, sitemap and more… this can take up to a
            minute.
          </p>
        )}
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
      </Card>

      <Card className="p-0">
        <h2 className="px-5 pt-5 font-semibold">Past audits</h2>
        {audits === null ? (
          <p className="px-5 py-4 text-sm text-slate-400">Loading…</p>
        ) : audits.length === 0 ? (
          <p className="px-5 py-4 text-sm text-slate-500">No audits yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {audits.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                <ScoreBadge score={a.score ?? null} />
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/prospects/${a.id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {a.businessName || a.url}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {a.url} · {formatDateTime(a.createdAt)}
                    {a.status === 'failed' && ' · site could not be loaded'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const SEVERITY = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-slate-100 text-slate-600',
};

function Check({ label, ok, value }: { label: string; ok: boolean | null; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-1.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={ok === null ? 'text-slate-500' : ok ? 'text-green-700' : 'text-red-700'}>
        {ok === null ? '' : ok ? '✓ ' : '✗ '}
        {value}
      </span>
    </div>
  );
}

function AuditView({ id }: { id: string }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [audit, setAudit] = useState<ProspectAudit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ audit: ProspectAudit }>(`/api/prospects/${id}`)
      .then((r) => setAudit(r.audit))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  async function remove() {
    if (!(await confirm({ title: 'Delete this audit?', confirmLabel: 'Delete', danger: true })))
      return;
    await api(`/api/prospects/${id}`, { method: 'DELETE' });
    navigate('/prospects');
  }

  if (error) return <Alert>{error}</Alert>;
  if (!audit) return <p className="text-sm text-slate-400">Loading…</p>;
  const c = audit.checks;
  const r = audit.report;
  const agency = me?.agency;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to="/prospects" className="text-sm text-[var(--brand)] hover:underline">
          ← All audits
        </Link>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={remove}>
            Delete
          </Button>
          <Button onClick={() => window.print()}>Download PDF</Button>
        </div>
      </div>

      <Card className="print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            {agency?.logoUrl && <img src={agency.logoUrl} alt="" className="h-10 w-auto" />}
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Free website audit by {agency?.name}
              </div>
              <h1 className="text-xl font-bold">{audit.businessName || audit.url}</h1>
              <div className="text-xs text-slate-500">
                {audit.url} · {formatDateTime(audit.createdAt)}
              </div>
            </div>
          </div>
          <div className="text-center">
            <ScoreBadge score={c?.score ?? null} size="lg" />
            <div className="mt-1 text-xs text-slate-500">Audit score</div>
          </div>
        </div>

        {r && (
          <>
            <p className="mt-4 text-slate-700">{r.summary}</p>

            <h2 className="mt-6 font-semibold">Issues found</h2>
            <ul className="mt-2 space-y-3">
              {r.issues.map((i) => (
                <li
                  key={i.title}
                  className="break-inside-avoid rounded-lg border border-slate-200 p-3"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${SEVERITY[i.severity]}`}
                    >
                      {i.severity}
                    </span>
                    <span className="font-medium">{i.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{i.detail}</p>
                  <p className="mt-1 text-sm">
                    <b>Fix:</b> {i.fix}
                  </p>
                </li>
              ))}
            </ul>

            <h2 className="mt-6 font-semibold">Growth opportunities</h2>
            <ul className="ml-5 mt-2 list-disc text-sm text-slate-700">
              {r.opportunities.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </>
        )}

        {c && (
          <div className="mt-6 break-inside-avoid">
            <h2 className="font-semibold">Measured checks</h2>
            <div className="mt-2 grid gap-x-8 md:grid-cols-2">
              <Check
                label="Mobile speed"
                ok={c.mobileScore === null ? null : c.mobileScore >= 50}
                value={c.mobileScore === null ? 'n/a' : `${c.mobileScore}/100`}
              />
              <Check
                label="Desktop speed"
                ok={c.desktopScore === null ? null : c.desktopScore >= 50}
                value={c.desktopScore === null ? 'n/a' : `${c.desktopScore}/100`}
              />
              <Check label="HTTPS (secure)" ok={c.https} value={c.https ? 'Yes' : 'No'} />
              <Check
                label="Mobile-friendly tag"
                ok={c.viewport}
                value={c.viewport ? 'Yes' : 'No'}
              />
              <Check
                label="Page title"
                ok={Boolean(c.title)}
                value={c.title ? `${c.title.length} chars` : 'Missing'}
              />
              <Check
                label="Meta description"
                ok={Boolean(c.metaDescription)}
                value={c.metaDescription ? `${c.metaDescription.length} chars` : 'Missing'}
              />
              <Check label="H1 heading" ok={c.h1.length === 1} value={`${c.h1.length} found`} />
              <Check
                label="Structured data"
                ok={c.schemaTypes.length > 0}
                value={c.schemaTypes.join(', ') || 'None'}
              />
              <Check
                label="Images with alt text"
                ok={c.imagesMissingAlt === 0}
                value={`${c.images - c.imagesMissingAlt}/${c.images}`}
              />
              <Check label="Words on page" ok={c.wordCount >= 300} value={String(c.wordCount)} />
              <Check
                label="sitemap.xml"
                ok={c.sitemap}
                value={c.sitemap === null ? 'Unknown' : c.sitemap ? 'Found' : 'Missing'}
              />
              <Check
                label="robots.txt"
                ok={c.robotsTxt}
                value={c.robotsTxt === null ? 'Unknown' : c.robotsTxt ? 'Found' : 'Missing'}
              />
            </div>
            {c.fetchError && <p className="mt-2 text-sm text-red-700">⚠ {c.fetchError}</p>}
          </div>
        )}

        {r && (
          <div className="mt-6 break-inside-avoid rounded-lg bg-slate-50 p-4">
            <h2 className="font-semibold">How {agency?.name} can help</h2>
            <p className="mt-1 text-sm text-slate-700">{r.pitch}</p>
          </div>
        )}
        <p className="mt-4 text-xs text-slate-400 print:hidden">
          {audit.reportSource === 'ai'
            ? '✨ Written by AI from the measured checks above. Read it before sending.'
            : 'AI was unavailable, so this write-up was generated from rules based on the measured checks.'}
        </p>
      </Card>
    </div>
  );
}
