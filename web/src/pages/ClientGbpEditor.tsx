// Client "Google profile" tab: AI suggestions for the Business Profile -> review (before/after,
// editable) -> owner applies on Google -> status -> undo. Plus Google Posts: AI drafts, edit,
// publish now or schedule.
import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AiLanguage } from '../lib/types';

type Notify = (kind: 'success' | 'error' | 'info', text: string) => void;
type Kind = 'description' | 'categories' | 'services' | 'hours' | 'attributes';
type Day = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';
type Cat = { name: string; displayName: string };
type Service = { label: string; description: string; category: string; structured?: boolean };
type Hour = { day: Day; open: string; close: string };
type Attr = { name: string; value: boolean };

type Profile = {
  description: string;
  primaryCategory: Cat | null;
  additionalCategories: Cat[];
  services: Service[];
  hours: Hour[];
  attributes: Attr[];
  verified: boolean | null;
  hasPendingEdits: boolean;
};

type After =
  | { description: string }
  | { additionalCategories: Cat[] }
  | { services: Service[] }
  | { hours: Hour[] }
  | { attributes: Attr[] };

type Change = {
  id: string;
  kind: Kind;
  source: 'ai' | 'manual' | 'undo';
  status: 'draft' | 'applied' | 'pending_google' | 'failed' | 'rejected' | 'reverted';
  reason: string | null;
  before: After | null;
  after: After;
  error: string | null;
  appliedAt: number | null;
  createdAt: number;
};

type Post = {
  id: string;
  summary: string;
  actionType: string | null;
  actionUrl: string | null;
  source: 'ai' | 'manual';
  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'deleted';
  scheduledFor: number | null;
  searchUrl: string | null;
  error: string | null;
  publishedAt: number | null;
  createdAt: number;
};

type Editor = {
  profile: Profile | null;
  profileError: string | null;
  changes: Change[];
  posts: Post[];
  canApply: boolean;
};

const KIND_LABEL: Record<Kind, string> = {
  description: 'Business description',
  categories: 'Additional categories',
  services: 'Services',
  hours: 'Opening hours',
  attributes: 'Attributes',
};
const STATUS: Record<Change['status'], { label: string; cls: string }> = {
  draft: { label: 'Waiting for approval', cls: 'bg-slate-100 text-slate-700' },
  applied: { label: 'Live on Google', cls: 'bg-green-100 text-green-800' },
  pending_google: { label: 'Google is reviewing', cls: 'bg-blue-100 text-blue-800' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-700' },
  rejected: { label: 'Rejected', cls: 'bg-slate-100 text-slate-500' },
  reverted: { label: 'Undone', cls: 'bg-slate-100 text-slate-500' },
};
const DAYS: Day[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const ACTIONS = ['LEARN_MORE', 'CALL', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP'];
const select = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm';
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');

export function GbpEditorTab({ clientId, notify }: { clientId: string; notify: Notify }) {
  const [data, setData] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attrNames, setAttrNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setData(await api<Editor>(`/api/clients/${clientId}/gbp/editor`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [clientId]);
  useEffect(() => {
    void load();
    api<{ attributes: { name: string; displayName: string }[] }>(
      `/api/clients/${clientId}/gbp/attributes`,
    )
      .then((r) =>
        setAttrNames(Object.fromEntries(r.attributes.map((a) => [a.name, a.displayName]))),
      )
      .catch(() => undefined);
  }, [load, clientId]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Skeleton className="h-64" />;
  if (data.profileError && !data.profile) {
    return (
      <Alert kind="info">
        {data.profileError} (Open the “Local SEO &amp; reviews” tab to connect Business Profile and
        pick the location.)
      </Alert>
    );
  }
  const p = data.profile!;
  const drafts = data.changes.filter((c) => c.status === 'draft' || c.status === 'failed');
  const history = data.changes.filter((c) => c.status !== 'draft' && c.status !== 'failed');
  const props = { clientId, notify, reload: load, canApply: data.canApply, attrNames };

  return (
    <div className="space-y-6">
      {p.verified === false && (
        <Alert>
          ⚠ This location is <b>not verified</b> on Google. Changes and posts may be rejected or not
          shown until the owner verifies it at business.google.com.
        </Alert>
      )}
      {p.hasPendingEdits && (
        <Alert kind="info">Google is still reviewing earlier edits to this profile.</Alert>
      )}
      {!data.canApply && (
        <Alert kind="info">
          You can prepare and edit changes. Only the agency owner can apply them on Google.
        </Alert>
      )}

      <SuggestCard {...props} />

      {drafts.length > 0 && (
        <div className="space-y-4">
          <h2 className="font-semibold">Changes waiting for approval ({drafts.length})</h2>
          {drafts.map((c) => (
            <DraftCard key={c.id} change={c} profile={p} {...props} />
          ))}
        </div>
      )}

      <CurrentProfileCard profile={p} {...props} />
      <HoursCard profile={p} {...props} />
      <PostsSection posts={data.posts} {...props} />

      {history.length > 0 && <HistoryCard changes={history} {...props} />}
    </div>
  );
}

type Common = {
  clientId: string;
  notify: Notify;
  reload: () => Promise<void>;
  canApply: boolean;
  attrNames: Record<string, string>;
};

// ------------------------------------ suggestions ------------------------------------

function SuggestCard({ clientId, notify, reload }: Common) {
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  async function run() {
    setBusy(true);
    try {
      const r = await api<{ drafts: Change[]; notes: string[] }>(
        `/api/clients/${clientId}/gbp/suggestions`,
        {
          method: 'POST',
          body: { language, notes: notes || undefined },
        },
      );
      setAiNotes(r.notes);
      notify(
        r.drafts.length ? 'success' : 'info',
        r.drafts.length
          ? `AI prepared ${r.drafts.length} change(s). Review them below; nothing is changed on Google yet.`
          : 'AI found nothing to change right now.',
      );
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h3 className="font-semibold">✨ Improve this Google profile with AI</h3>
      <p className="mt-1 text-sm text-slate-500">
        AI suggests a better description, extra categories, services and yes/no attributes. You
        review and edit each one; it goes to Google only after the owner clicks “Apply to Google”.
        AI never changes the name, address or phone.
      </p>
      <textarea
        className={`${inputClass} mt-3 min-h-14`}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={1500}
        placeholder="Facts AI should use (optional): main services, areas served, years in business…"
        aria-label="Facts about the business"
      />
      <div className="mt-2 flex items-center gap-2">
        <select
          className={select}
          value={language}
          onChange={(e) => setLanguage(e.target.value as AiLanguage)}
          aria-label="Language"
        >
          <option value="en">English</option>
          <option value="hinglish">Hinglish</option>
          <option value="hi">Hindi</option>
        </select>
        <Button loading={busy} onClick={run}>
          Get AI suggestions
        </Button>
      </div>
      {aiNotes.length > 0 && (
        <ul className="ml-5 mt-3 list-disc text-sm text-amber-800">
          {aiNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------ draft card ------------------------------------

function DraftCard({
  change,
  profile,
  clientId,
  notify,
  reload,
  canApply,
  attrNames,
}: Common & { change: Change; profile: Profile }) {
  const confirm = useConfirm();
  const [after, setAfter] = useState<After>(change.after);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const update = (a: After) => {
    setAfter(a);
    setDirty(true);
  };

  async function call(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const save = () =>
    api(`/api/clients/${clientId}/gbp/changes/${change.id}`, { method: 'PATCH', body: { after } });

  async function apply() {
    const ok = await confirm({
      title: `Apply “${KIND_LABEL[change.kind]}” to Google?`,
      message: 'This changes the public Google listing. You can undo it later from the history.',
      confirmLabel: 'Apply to Google',
    });
    if (!ok) return;
    await call('apply', async () => {
      if (dirty) await save();
      const r = await api<{ status: string; error: string | null }>(
        `/api/clients/${clientId}/gbp/changes/${change.id}/apply`,
        { method: 'POST', body: {} },
      );
      if (r.status === 'failed') notify('error', `Google rejected the change: ${r.error}`);
      else if (r.status === 'pending_google')
        notify('info', 'Sent to Google. Google is reviewing it (can take a few days).');
      else notify('success', 'Live on Google ✓');
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{KIND_LABEL[change.kind]}</h3>
          <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[change.status].cls}`}>
            {STATUS[change.status].label}
          </span>
          {change.source === 'ai' && (
            <span className="text-xs text-slate-500">✨ AI suggestion</span>
          )}
        </div>
        <span className="text-xs text-slate-400">{formatDateTime(change.createdAt)}</span>
      </div>
      {change.reason && <p className="mt-1 text-sm text-slate-500">{change.reason}</p>}
      {change.error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{change.error}</p>
      )}

      <div className="mt-3">
        <ChangeEditor
          kind={change.kind}
          after={after}
          profile={profile}
          onChange={update}
          attrNames={attrNames}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          loading={busy === 'apply'}
          disabled={!canApply}
          onClick={apply}
          title={canApply ? '' : 'Only the owner can apply'}
        >
          Apply to Google
        </Button>
        {dirty && (
          <Button
            variant="secondary"
            loading={busy === 'save'}
            onClick={() =>
              call('save', async () => {
                await save();
                setDirty(false);
                notify('success', 'Saved.');
              })
            }
          >
            Save edits
          </Button>
        )}
        <Button
          variant="secondary"
          loading={busy === 'reject'}
          onClick={() =>
            call('reject', () =>
              api(`/api/clients/${clientId}/gbp/changes/${change.id}/reject`, {
                method: 'POST',
                body: {},
              }).then(() => undefined),
            )
          }
        >
          Reject
        </Button>
      </div>
    </Card>
  );
}

/** Before/after view; the "after" side is editable. */
function ChangeEditor({
  kind,
  after,
  profile,
  onChange,
  attrNames,
}: {
  kind: Kind;
  after: After;
  profile: Profile;
  onChange: (a: After) => void;
  attrNames: Record<string, string>;
}) {
  if (kind === 'description' && 'description' in after) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">Now on Google</div>
          <p className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm text-slate-600">
            {profile.description || <i>(empty)</i>}
          </p>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs font-medium text-slate-500">
            <span>New</span>
            <span className={after.description.length > 750 ? 'text-red-600' : ''}>
              {after.description.length}/750
            </span>
          </div>
          <textarea
            className={`${inputClass} min-h-40`}
            value={after.description}
            onChange={(e) => onChange({ description: e.target.value })}
            maxLength={750}
            aria-label="New description"
          />
        </div>
      </div>
    );
  }
  if (kind === 'categories' && 'additionalCategories' in after) {
    const had = new Set(profile.additionalCategories.map((c) => c.name));
    return (
      <div>
        <p className="text-xs text-slate-500">
          Primary category (not changed): <b>{profile.primaryCategory?.displayName ?? '—'}</b>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {after.additionalCategories.map((c) => (
            <span
              key={c.name}
              className={`rounded-full px-3 py-1 text-xs ${had.has(c.name) ? 'bg-slate-100' : 'bg-green-100 text-green-800'}`}
            >
              {had.has(c.name) ? '' : '+ '}
              {c.displayName}
              <button
                className="ml-2 text-slate-500 hover:text-red-600"
                aria-label={`Remove ${c.displayName}`}
                onClick={() =>
                  onChange({
                    additionalCategories: after.additionalCategories.filter(
                      (x) => x.name !== c.name,
                    ),
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (kind === 'services' && 'services' in after) {
    const had = new Set(profile.services.map((s) => s.label.toLowerCase()));
    return (
      <ul className="space-y-2 text-sm">
        {after.services.map((s, i) => (
          <li
            key={`${s.label}-${i}`}
            className={`flex items-start justify-between gap-3 rounded p-2 ${had.has(s.label.toLowerCase()) ? 'bg-slate-50' : 'bg-green-50'}`}
          >
            <div className="min-w-0 flex-1">
              {had.has(s.label.toLowerCase()) ? (
                <span className="font-medium">{s.label}</span>
              ) : (
                <input
                  className={`${inputClass} py-1`}
                  value={s.label}
                  maxLength={140}
                  aria-label="Service name"
                  onChange={(e) =>
                    onChange({
                      services: after.services.map((x, j) =>
                        j === i ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                />
              )}
              {s.description && <p className="mt-1 text-xs text-slate-500">{s.description}</p>}
            </div>
            {!s.structured && (
              <button
                className="text-xs text-red-600 hover:underline"
                onClick={() => onChange({ services: after.services.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (kind === 'hours' && 'hours' in after) {
    return <HoursTable hours={after.hours} />;
  }
  if (kind === 'attributes' && 'attributes' in after) {
    return (
      <ul className="space-y-1 text-sm">
        {after.attributes.map((a, i) => (
          <li
            key={a.name}
            className="flex items-center justify-between gap-3 border-b border-slate-100 py-1"
          >
            <span>{attrNames[a.name] ?? a.name}</span>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={a.value}
                onChange={(e) =>
                  onChange({
                    attributes: after.attributes.map((x, j) =>
                      j === i ? { ...x, value: e.target.checked } : x,
                    ),
                  })
                }
              />
              {a.value ? 'Yes' : 'No'}
            </label>
          </li>
        ))}
      </ul>
    );
  }
  return <pre className="text-xs">{JSON.stringify(after, null, 2)}</pre>;
}

function HoursTable({ hours }: { hours: Hour[] }) {
  return (
    <table className="text-sm">
      <tbody>
        {DAYS.map((d) => {
          const h = hours.filter((x) => x.day === d);
          return (
            <tr key={d}>
              <td className="pr-6 text-slate-500">{title(d)}</td>
              <td>{h.length ? h.map((x) => `${x.open}–${x.close}`).join(', ') : 'Closed'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------ current profile / manual edits ------------------------------------

function CurrentProfileCard({ profile, clientId, notify, reload }: Common & { profile: Profile }) {
  const [busy, setBusy] = useState(false);
  async function editDescription() {
    setBusy(true);
    try {
      await api(`/api/clients/${clientId}/gbp/changes`, {
        method: 'POST',
        body: {
          kind: 'description',
          after: { description: profile.description || 'Write the description here.' },
        },
      });
      await reload();
      notify('info', 'A description draft was added above. Edit it, then apply.');
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h3 className="font-semibold">Now on Google</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[10rem_1fr]">
        <dt className="text-slate-500">Description</dt>
        <dd>
          <p className="whitespace-pre-wrap">
            {profile.description || <span className="text-amber-700">⚠ Missing</span>}
          </p>
          <button
            className="mt-1 text-xs text-[var(--brand)] hover:underline"
            disabled={busy}
            onClick={editDescription}
          >
            Edit description manually
          </button>
        </dd>
        <dt className="text-slate-500">Primary category</dt>
        <dd>{profile.primaryCategory?.displayName ?? '—'}</dd>
        <dt className="text-slate-500">Other categories</dt>
        <dd>{profile.additionalCategories.map((c) => c.displayName).join(', ') || '—'}</dd>
        <dt className="text-slate-500">Services</dt>
        <dd>
          {profile.services.map((s) => s.label).join(', ') || (
            <span className="text-amber-700">⚠ None</span>
          )}
        </dd>
      </dl>
    </Card>
  );
}

function HoursCard({ profile, clientId, notify, reload }: Common & { profile: Profile }) {
  const init = () =>
    Object.fromEntries(
      DAYS.map((d) => {
        const h = profile.hours.find((x) => x.day === d);
        return [
          d,
          h
            ? { closed: false, open: h.open, close: h.close }
            : { closed: true, open: '09:00', close: '18:00' },
        ];
      }),
    ) as Record<Day, { closed: boolean; open: string; close: string }>;
  const [rows, setRows] = useState(init);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  async function draft() {
    setBusy(true);
    try {
      const hours = DAYS.filter((d) => !rows[d].closed).map((d) => ({
        day: d,
        open: rows[d].open,
        close: rows[d].close,
      }));
      await api(`/api/clients/${clientId}/gbp/changes`, {
        method: 'POST',
        body: { kind: 'hours', after: { hours } },
      });
      setEditing(false);
      await reload();
      notify('info', 'Opening hours draft added above. Apply it to send it to Google.');
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Opening hours</h3>
        {!editing && (
          <button
            className="text-xs text-[var(--brand)] hover:underline"
            onClick={() => setEditing(true)}
          >
            Change hours
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        AI never guesses timings: enter the real hours from the business owner.
      </p>
      <div className="mt-3">
        {!editing ? (
          profile.hours.length ? (
            <HoursTable hours={profile.hours} />
          ) : (
            <p className="text-sm text-amber-700">⚠ Opening hours are missing</p>
          )
        ) : (
          <div className="space-y-2">
            {DAYS.map((d) => (
              <div key={d} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-24 text-slate-600">{title(d)}</span>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={rows[d].closed}
                    onChange={(e) =>
                      setRows({ ...rows, [d]: { ...rows[d], closed: e.target.checked } })
                    }
                  />
                  Closed
                </label>
                {!rows[d].closed && (
                  <>
                    <input
                      type="time"
                      className={select}
                      value={rows[d].open}
                      onChange={(e) =>
                        setRows({ ...rows, [d]: { ...rows[d], open: e.target.value } })
                      }
                      aria-label={`${d} opens`}
                    />
                    <span>to</span>
                    <input
                      type="time"
                      className={select}
                      value={rows[d].close}
                      onChange={(e) =>
                        setRows({ ...rows, [d]: { ...rows[d], close: e.target.value } })
                      }
                      aria-label={`${d} closes`}
                    />
                  </>
                )}
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Button loading={busy} onClick={draft}>
                Prepare change
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setRows(init());
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------ history ------------------------------------

function HistoryCard({
  changes,
  clientId,
  notify,
  reload,
  canApply,
}: Common & { changes: Change[] }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  async function undo(c: Change) {
    if (
      !(await confirm({
        title: `Undo “${KIND_LABEL[c.kind]}”?`,
        message: 'The previous value is put back on Google.',
        confirmLabel: 'Undo',
      }))
    )
      return;
    setBusy(c.id);
    try {
      const r = await api<{ status: string; error: string | null }>(
        `/api/clients/${clientId}/gbp/changes/${c.id}/undo`,
        { method: 'POST', body: {} },
      );
      if (r.status === 'failed') notify('error', `Undo failed: ${r.error}`);
      else notify('success', 'Previous value restored.');
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="p-0">
      <h3 className="px-5 pt-5 font-semibold">History</h3>
      <ul className="mt-3 divide-y divide-slate-100">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[c.status].cls}`}>
              {STATUS[c.status].label}
            </span>
            <span className="font-medium">{KIND_LABEL[c.kind]}</span>
            <span className="text-xs text-slate-500">
              {c.source === 'ai' ? '✨ AI' : c.source === 'undo' ? 'undo' : 'manual'} ·{' '}
              {formatDateTime(c.appliedAt ?? c.createdAt)}
            </span>
            {canApply && (c.status === 'applied' || c.status === 'pending_google') && (
              <Button
                variant="secondary"
                className="ml-auto px-3 py-1 text-xs"
                loading={busy === c.id}
                onClick={() => undo(c)}
              >
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------ posts ------------------------------------

function PostsSection({ posts, clientId, notify, reload, canApply }: Common & { posts: Post[] }) {
  const [topic, setTopic] = useState('');
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [busy, setBusy] = useState(false);
  async function generate() {
    setBusy(true);
    try {
      await api(`/api/clients/${clientId}/gbp/posts/generate`, {
        method: 'POST',
        body: { topic, language },
      });
      notify('success', 'AI wrote post drafts. Edit, then publish or schedule them.');
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const open = posts.filter((p) =>
    ['draft', 'failed', 'scheduled', 'publishing'].includes(p.status),
  );
  const done = posts.filter((p) => p.status === 'published');
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-semibold">✨ Google Posts</h3>
        <p className="mt-1 text-sm text-slate-500">
          Regular posts keep the profile active. AI writes drafts; the owner publishes now or
          schedules them (the app publishes scheduled posts every hour).
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            className={inputClass}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic, e.g. Diwali greetings, new teeth whitening service, monsoon tips"
            maxLength={200}
            aria-label="Post topic"
          />
          <select
            className={select}
            value={language}
            onChange={(e) => setLanguage(e.target.value as AiLanguage)}
            aria-label="Language"
          >
            <option value="en">English</option>
            <option value="hinglish">Hinglish</option>
            <option value="hi">Hindi</option>
          </select>
          <Button loading={busy} disabled={topic.trim().length < 3} onClick={generate}>
            Write posts
          </Button>
        </div>
      </Card>
      {open.map((p) => (
        <PostCard
          key={p.id}
          post={p}
          clientId={clientId}
          notify={notify}
          reload={reload}
          canApply={canApply}
        />
      ))}
      {done.length > 0 && (
        <Card className="p-0">
          <h3 className="px-5 pt-5 font-semibold">Published posts</h3>
          <ul className="mt-3 divide-y divide-slate-100">
            {done.map((p) => (
              <PublishedPost
                key={p.id}
                post={p}
                clientId={clientId}
                notify={notify}
                reload={reload}
                canApply={canApply}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

type PostProps = {
  post: Post;
  clientId: string;
  notify: Notify;
  reload: () => Promise<void>;
  canApply: boolean;
};

const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function PostCard({ post, clientId, notify, reload, canApply }: PostProps) {
  const confirm = useConfirm();
  const [summary, setSummary] = useState(post.summary);
  const [action, setAction] = useState(post.actionType ?? '');
  const [url, setUrl] = useState(post.actionUrl ?? '');
  const [when, setWhen] = useState(
    post.scheduledFor ? toLocalInput(post.scheduledFor) : toLocalInput(Date.now() + 86_400_000),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const dirty =
    summary !== post.summary ||
    action !== (post.actionType ?? '') ||
    url !== (post.actionUrl ?? '');
  const body = {
    summary,
    actionType: action || null,
    actionUrl: action && action !== 'CALL' ? url || null : null,
  };
  const base = `/api/clients/${clientId}/gbp/posts/${post.id}`;

  async function run(kind: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(kind);
    try {
      if (dirty && kind !== 'delete') await api(base, { method: 'PATCH', body });
      await fn();
      if (ok) notify('success', ok);
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded px-1.5 py-0.5 ${post.status === 'failed' ? 'bg-red-100 text-red-700' : post.status === 'scheduled' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'}`}
        >
          {post.status === 'scheduled' && post.scheduledFor
            ? `Scheduled for ${formatDateTime(post.scheduledFor)}`
            : title(post.status)}
        </span>
        {post.source === 'ai' && <span className="text-slate-500">✨ AI draft</span>}
      </div>
      {post.error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{post.error}</p>
      )}
      <textarea
        className={`${inputClass} mt-3 min-h-28`}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        maxLength={1500}
        aria-label="Post text"
      />
      <div className="mt-1 text-right text-xs text-slate-400">{summary.length}/1500</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className={select}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="Button"
        >
          <option value="">No button</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              Button: {title(a)}
            </option>
          ))}
        </select>
        {action && action !== 'CALL' && (
          <input
            className={`${inputClass} max-w-sm`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            aria-label="Button link"
          />
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          loading={busy === 'publish'}
          disabled={!canApply || post.status === 'publishing'}
          onClick={async () => {
            if (
              !(await confirm({
                title: 'Publish this post on Google now?',
                confirmLabel: 'Publish',
              }))
            )
              return;
            await run(
              'publish',
              async () => {
                const r = await api<{ status: string; error: string | null }>(`${base}/publish`, {
                  method: 'POST',
                  body: {},
                });
                if (r.status === 'failed') throw new Error(`Google rejected the post: ${r.error}`);
              },
              'Post published on Google ✓',
            );
          }}
        >
          Publish now
        </Button>
        <input
          type="datetime-local"
          className={select}
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          aria-label="Schedule time"
          disabled={!canApply}
        />
        <Button
          variant="secondary"
          loading={busy === 'schedule'}
          disabled={!canApply}
          onClick={() =>
            run(
              'schedule',
              () =>
                api(`${base}/schedule`, {
                  method: 'POST',
                  body: { scheduledFor: new Date(when).getTime() },
                }),
              'Post scheduled.',
            )
          }
        >
          Schedule
        </Button>
        {post.status === 'scheduled' && (
          <Button
            variant="secondary"
            loading={busy === 'unschedule'}
            onClick={() =>
              run('unschedule', () =>
                api(`${base}/schedule`, { method: 'POST', body: { scheduledFor: null } }),
              )
            }
          >
            Unschedule
          </Button>
        )}
        {dirty && (
          <Button
            variant="secondary"
            loading={busy === 'save'}
            onClick={() => run('save', async () => undefined, 'Saved.')}
          >
            Save
          </Button>
        )}
        <button
          className="ml-auto text-xs text-red-600 hover:underline"
          onClick={() => run('delete', () => api(base, { method: 'DELETE' }))}
        >
          Delete draft
        </button>
      </div>
    </Card>
  );
}

function PublishedPost({ post, clientId, notify, reload, canApply }: PostProps) {
  const confirm = useConfirm();
  async function remove() {
    if (
      !(await confirm({
        title: 'Delete this post from Google?',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await api(`/api/clients/${clientId}/gbp/posts/${post.id}`, { method: 'DELETE' });
      await reload();
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }
  return (
    <li className="px-5 py-3 text-sm">
      <p className="line-clamp-2 whitespace-pre-wrap">{post.summary}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span>Published {formatDateTime(post.publishedAt)}</span>
        {post.searchUrl && (
          <a
            href={post.searchUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--brand)] hover:underline"
          >
            View on Google ↗
          </a>
        )}
        {canApply && (
          <button className="text-red-600 hover:underline" onClick={remove}>
            Delete from Google
          </button>
        )}
      </div>
    </li>
  );
}
