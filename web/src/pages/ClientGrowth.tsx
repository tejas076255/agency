// "Grow" tab: Connect (one Google sign-in) -> Auto-detect -> Scan -> Business Profile score +
// checklist -> AI fixes ready -> one-click Post / Post all -> before/after score.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';

type Notify = (kind: 'success' | 'error' | 'info', text: string) => void;

type ScoreItem = {
  id: string;
  group: 'basics' | 'content' | 'trust' | 'consistency';
  title: string;
  status: 'ok' | 'improve' | 'missing';
  points: number;
  max: number;
  why: string;
  detail: string;
  fix: 'ai' | 'app' | 'you' | 'google';
};
type Change = {
  id: string;
  kind: 'description' | 'categories' | 'services' | 'hours' | 'attributes' | 'website';
  source: string;
  status: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  error: string | null;
};
type Post = {
  id: string;
  summary: string;
  actionType: string | null;
  actionUrl: string | null;
  status: string;
  error: string | null;
};
type ReviewDraft = {
  id: string;
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
  draft: string;
};
type Progress = { step: number; total: number; label: string; done: boolean; error: string | null };

type ProfileData = {
  setup: {
    googleConnected: boolean;
    businessConnected: boolean;
    locationSelected: boolean;
    searchConsoleSelected: boolean;
    analyticsSelected: boolean;
  };
  scan: {
    runAt: number;
    status: 'ok' | 'partial' | 'failed';
    score: number | null;
    projectedScore: number | null;
    items: ScoreItem[];
    error: string | null;
  } | null;
  previousScore: number | null;
  scanning: boolean;
  progress: Progress | null;
  steps: string[];
  fixes: { changes: Change[]; posts: Post[]; reviews: ReviewDraft[] };
  canPublish: boolean;
};

type Cand<T> = { value: T; label: string; score: number; reasons: string[] };
type Source<T> = {
  connected: boolean;
  current: T | null;
  recommended: Cand<T> | null;
  candidates: Cand<T>[];
  autoApplied: boolean;
  mismatch: boolean;
  needsChoice: boolean;
  error?: string;
};
type GbpVal = { accountName: string; locationName: string };
type Detect = {
  website: { host: string | null; siteName: string | null; error: string | null };
  gsc: Source<string>;
  ga4: Source<string>;
  gbp: Source<GbpVal>;
  youtube: Source<string>;
  complete: boolean;
};

type FixRef = { type: 'change' | 'post' | 'review'; id: string };

const KIND_LABEL: Record<Change['kind'], string> = {
  description: 'Business description',
  categories: 'Extra categories',
  services: 'Services',
  hours: 'Opening hours',
  attributes: 'Attributes',
  website: 'Website link',
};
/** Score items each fix completes (same mapping as the server). */
const FIX_ITEMS: Record<string, string[]> = {
  description: ['description_present', 'description_quality'],
  services: ['services'],
  categories: ['extra_categories'],
  attributes: ['attributes'],
  hours: ['hours'],
  website: ['website'],
  posts: ['posts'],
  replies: ['replies'],
};
const tone = (s: number | null) =>
  s === null ? 'slate' : s >= 75 ? 'green' : s >= 50 ? 'amber' : 'red';
const COLOR = { green: '#16a34a', amber: '#d97706', red: '#dc2626', slate: '#94a3b8' };
const verdict = (s: number) =>
  s >= 85
    ? 'Excellent! Keep posting and replying.'
    : s >= 70
      ? 'Good, a few things can make it great.'
      : s >= 50
        ? 'Okay, but you are losing customers to competitors.'
        : 'Needs attention: many customers cannot find key details.';

// ------------------------------------ main ------------------------------------

export function GrowTab({
  clientId,
  notify,
  justConnected,
}: {
  clientId: string;
  notify: Notify;
  justConnected: boolean;
}) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetect, setShowDetect] = useState(justConnected);
  const [result, setResult] = useState<{
    before: number | null;
    after: number | null;
    ok: number;
    failed: { label: string; error: string | null }[];
  } | null>(null);
  const autoStarted = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api<ProfileData>(`/api/clients/${clientId}/profile`);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while a scan runs.
  useEffect(() => {
    if (!data?.scanning) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [data?.scanning, load]);

  const startScan = useCallback(
    async (setup = false) => {
      try {
        await api(`/api/clients/${clientId}/profile/scan`, { method: 'POST', body: { setup } });
        setResult(null);
        await load();
      } catch (e) {
        notify('error', (e as Error).message);
      }
    },
    [clientId, load, notify],
  );

  // No clicks needed: once the location is known and there is no scan yet, scan automatically.
  useEffect(() => {
    if (!data || autoStarted.current || showDetect) return;
    if (data.setup.locationSelected && !data.scan && !data.scanning) {
      autoStarted.current = true;
      void startScan(true);
    }
  }, [data, showDetect, startScan]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Skeleton className="h-72" />;

  if (!data.setup.googleConnected || !data.setup.businessConnected) {
    return <ConnectStep clientId={clientId} partly={data.setup.googleConnected} notify={notify} />;
  }
  if (showDetect || !data.setup.locationSelected) {
    return (
      <DetectStep
        clientId={clientId}
        notify={notify}
        onDone={async () => {
          setShowDetect(false);
          const d = await load();
          if (d && d.setup.locationSelected && !d.scanning) {
            autoStarted.current = true;
            await startScan(true);
          }
        }}
      />
    );
  }
  if (data.scanning || (!data.scan && data.progress && !data.progress.done)) {
    return <ScanStep steps={data.steps} progress={data.progress} />;
  }
  if (!data.scan) return <ScanStep steps={data.steps} progress={null} />;
  if (data.scan.status === 'failed') {
    return (
      <Card>
        <h3 className="font-semibold">The scan could not finish</h3>
        <p className="mt-1 text-sm text-red-700">{data.scan.error}</p>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => startScan()}>Try again</Button>
          <Button variant="secondary" onClick={() => setShowDetect(true)}>
            Check connections
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Dashboard
      clientId={clientId}
      data={data}
      result={result}
      notify={notify}
      onRescan={() => startScan()}
      onCheckConnections={() => setShowDetect(true)}
      onPublished={async (r) => {
        setResult(r);
        await load();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
      reload={load}
    />
  );
}

// ------------------------------------ 1. connect ------------------------------------

function Steps({ at }: { at: number }) {
  const names = ['Connect', 'Check', 'Score & fix'];
  return (
    <ol className="mb-4 flex items-center gap-2 text-xs">
      {names.map((n, i) => (
        <li key={n} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full font-semibold ${i < at ? 'bg-green-600 text-white' : i === at ? 'bg-[var(--brand)] text-white' : 'bg-slate-200 text-slate-500'}`}
          >
            {i < at ? '✓' : i + 1}
          </span>
          <span className={i === at ? 'font-medium text-slate-800' : 'text-slate-500'}>{n}</span>
          {i < names.length - 1 && <span className="h-px w-6 bg-slate-300" />}
        </li>
      ))}
    </ol>
  );
}

function ConnectStep({
  clientId,
  partly,
  notify,
}: {
  clientId: string;
  partly: boolean;
  notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/api/clients/${clientId}/setup/connect`, {
        method: 'POST',
        body: {},
      });
      window.location.href = url;
    } catch (e) {
      notify('error', (e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Card className="mx-auto max-w-xl text-center">
      <Steps at={0} />
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--brand)]/10 text-3xl">
        🚀
      </div>
      <h2 className="text-xl font-bold">
        {partly ? 'Connect Business Profile too' : 'Connect your business in one click'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        Sign in once with the Google account that manages this business. We will find the right
        Search Console, Analytics, Business Profile and YouTube automatically.
      </p>
      <Button className="mt-5 px-6 py-3 text-base" loading={busy} onClick={go}>
        Continue with Google
      </Button>
      <ul className="mx-auto mt-5 grid max-w-sm grid-cols-2 gap-2 text-left text-xs text-slate-600">
        <li>✓ Search Console</li>
        <li>✓ Google Analytics</li>
        <li>✓ Business Profile</li>
        <li>✓ YouTube (optional)</li>
      </ul>
      <p className="mt-4 text-xs text-slate-400">
        🔒 We only read data. Nothing is posted on Google until you click Post.
      </p>
    </Card>
  );
}

// ------------------------------------ 2. detect ------------------------------------

function DetectStep({
  clientId,
  notify,
  onDone,
}: {
  clientId: string;
  notify: Notify;
  onDone: () => Promise<void>;
}) {
  const [d, setD] = useState<Detect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<{
    gscSiteUrl?: string;
    ga4PropertyId?: string;
    gbp?: GbpVal;
    youtubeChannelId?: string;
  }>({});

  const run = useCallback(async () => {
    setError(null);
    try {
      const r = await api<Detect>(`/api/clients/${clientId}/setup/detect`);
      setD(r);
      setPick({});
    } catch (e) {
      setError((e as Error).message);
    }
  }, [clientId]);
  useEffect(() => {
    void run();
  }, [run]);

  async function save(extra = pick) {
    setBusy(true);
    try {
      if (Object.keys(extra).length) {
        await api(`/api/clients/${clientId}/setup/choose`, { method: 'POST', body: extra });
      }
      await onDone();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!d) {
    return (
      <Card className="mx-auto max-w-xl text-center">
        <Steps at={1} />
        <p className="text-sm text-slate-600">
          🔍 Finding your Search Console, Analytics and Business Profile…
        </p>
        <Skeleton className="mt-4 h-32" />
      </Card>
    );
  }

  const gbpMissing = !d.gbp.current && !pick.gbp;
  return (
    <Card className="mx-auto max-w-2xl">
      <Steps at={1} />
      <h2 className="text-lg font-bold">We found your accounts</h2>
      <p className="text-sm text-slate-500">
        Website: <b>{d.website.host ?? '—'}</b>
        {d.website.siteName && ` · ${d.website.siteName}`}
      </p>
      <div className="mt-4 space-y-3">
        <SourceRow
          title="Google Business Profile"
          required
          s={d.gbp}
          labelOf={(v) =>
            d.gbp.candidates.find((c) => c.value.locationName === v.locationName)?.label ??
            v.locationName
          }
          same={(a, b) => a.locationName === b.locationName}
          value={pick.gbp}
          onPick={(v) => setPick({ ...pick, gbp: v })}
        />
        <SourceRow
          title="Search Console"
          s={d.gsc}
          labelOf={(v) => v}
          same={(a, b) => a === b}
          value={pick.gscSiteUrl}
          onPick={(v) => setPick({ ...pick, gscSiteUrl: v })}
        />
        <SourceRow
          title="Google Analytics 4"
          s={d.ga4}
          labelOf={(v) => d.ga4.candidates.find((c) => c.value === v)?.label ?? v}
          same={(a, b) => a === b}
          value={pick.ga4PropertyId}
          onPick={(v) => setPick({ ...pick, ga4PropertyId: v })}
        />
        <SourceRow
          title="YouTube"
          s={d.youtube}
          labelOf={(v) => d.youtube.candidates.find((c) => c.value === v)?.label ?? v}
          same={(a, b) => a === b}
          value={pick.youtubeChannelId}
          onPick={(v) => setPick({ ...pick, youtubeChannelId: v })}
        />
      </div>
      {d.website.error && (
        <p className="mt-3 text-xs text-amber-700">
          Website could not be read ({d.website.error}); matching used names only.
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button loading={busy} disabled={gbpMissing} onClick={() => save()}>
          Continue → Check my profile
        </Button>
        <Button variant="secondary" onClick={run}>
          Check again
        </Button>
        {gbpMissing && (
          <span className="text-xs text-amber-700">
            Pick your Business Profile location to continue.
          </span>
        )}
      </div>
    </Card>
  );
}

function SourceRow<T>({
  title,
  s,
  labelOf,
  same,
  value,
  onPick,
  required = false,
}: {
  title: string;
  s: Source<T>;
  labelOf: (v: T) => string;
  same: (a: T, b: T) => boolean;
  value: T | undefined;
  onPick: (v: T) => void;
  required?: boolean;
}) {
  const chosen = value ?? s.current;
  const icon = !s.connected ? '○' : chosen ? (s.mismatch && !value ? '⚠' : '✓') : '?';
  const color = !s.connected
    ? 'text-slate-400'
    : chosen && !(s.mismatch && !value)
      ? 'text-green-600'
      : 'text-amber-600';
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 text-lg font-bold ${color}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{title}</span>
            {!required && <span className="text-xs text-slate-400">optional</span>}
            {s.autoApplied && (
              <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">
                auto-selected
              </span>
            )}
          </div>
          {!s.connected ? (
            <p className="text-sm text-slate-500">Not connected{s.error ? ` (${s.error})` : ''}</p>
          ) : chosen ? (
            <p className="truncate text-sm text-slate-700">{labelOf(chosen)}</p>
          ) : s.candidates.length === 0 ? (
            <p className="text-sm text-amber-700">
              Nothing found for this website on this Google account.
            </p>
          ) : null}
          {s.mismatch && s.recommended && !value && (
            <div className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">
              Better match found: <b>{s.recommended.label}</b> ({s.recommended.reasons.join(', ')}).{' '}
              <button
                className="font-medium text-[var(--brand)] hover:underline"
                onClick={() => onPick(s.recommended!.value)}
              >
                Switch to it
              </button>
            </div>
          )}
          {s.connected && (s.needsChoice || (!chosen && s.candidates.length > 0)) && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-slate-500">Which one is yours?</p>
              {s.candidates.slice(0, 5).map((c, i) => (
                <label
                  key={i}
                  className="flex cursor-pointer items-start gap-2 rounded p-1 text-sm hover:bg-slate-50"
                >
                  <input
                    type="radio"
                    name={title}
                    checked={Boolean(value && same(value, c.value))}
                    onChange={() => onPick(c.value)}
                    className="mt-1"
                  />
                  <span>
                    {c.label}
                    {i === 0 && (
                      <span className="ml-1 rounded bg-indigo-50 px-1 text-xs text-indigo-700">
                        recommended
                      </span>
                    )}
                    {c.reasons.length > 0 && (
                      <span className="block text-xs text-slate-500">{c.reasons.join(' · ')}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------ 3. scan ------------------------------------

function ScanStep({ steps, progress }: { steps: string[]; progress: Progress | null }) {
  const at = progress?.step ?? 0;
  const pct = Math.round(((progress?.done ? steps.length : at) / steps.length) * 100);
  return (
    <Card className="mx-auto max-w-xl">
      <Steps at={2} />
      <h2 className="text-lg font-bold">Checking your business… 🔍</h2>
      <ul className="mt-4 space-y-2 text-sm">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className="w-5 text-center">
              {i < at || progress?.done ? '✅' : i === at ? '⏳' : '○'}
            </span>
            <span
              className={i === at ? 'font-medium' : i < at ? 'text-slate-600' : 'text-slate-400'}
            >
              {s}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-[var(--brand)] transition-all duration-700"
          style={{ width: `${Math.max(5, pct)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Usually under a minute. You can leave this page; it continues in the background.
      </p>
    </Card>
  );
}

// ------------------------------------ 4. dashboard ------------------------------------

function useCountUp(target: number | null, from: number | null) {
  const [v, setV] = useState(from ?? target ?? 0);
  useEffect(() => {
    if (target === null) return;
    const start = from ?? target;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 1200);
      setV(Math.round(start + (target - start) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, from]);
  return v;
}

function ScoreRing({
  score,
  from,
  size = 132,
}: {
  score: number | null;
  from?: number | null;
  size?: number;
}) {
  const v = useCountUp(score, from ?? null);
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const col = COLOR[tone(score)];
  return (
    <div
      className="relative"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Score ${score ?? 'unknown'} out of 100`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#e2e8f0" strokeWidth="10" fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={col}
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums" style={{ color: col }}>
          {score === null ? '—' : v}
        </span>
        <span className="text-xs text-slate-400">/ 100</span>
      </div>
    </div>
  );
}

type PublishResult = {
  before: number | null;
  after: number | null;
  ok: number;
  failed: { label: string; error: string | null }[];
};

function Dashboard({
  clientId,
  data,
  result,
  notify,
  onRescan,
  onCheckConnections,
  onPublished,
  reload,
}: {
  clientId: string;
  data: ProfileData;
  result: PublishResult | null;
  notify: Notify;
  onRescan: () => void;
  onCheckConnections: () => void;
  onPublished: (r: PublishResult) => Promise<void>;
  reload: () => Promise<unknown>;
}) {
  const confirm = useConfirm();
  const scan = data.scan!;
  const items = scan.items;
  const { changes, posts, reviews } = data.fixes;
  const total = changes.length + posts.length + reviews.length;
  const [busy, setBusy] = useState(false);
  const missing = items.filter((i) => i.status === 'missing');
  const improve = items.filter((i) => i.status === 'improve');
  const ok = items.filter((i) => i.status === 'ok');
  const readyIds = new Set<string>([
    ...changes.flatMap((c) => FIX_ITEMS[c.kind] ?? []),
    ...(posts.length ? FIX_ITEMS.posts! : []),
    ...(reviews.length ? FIX_ITEMS.replies! : []),
  ]);
  const gainOf = (ids: string[]) =>
    Math.round(items.filter((i) => ids.includes(i.id)).reduce((s, i) => s + (i.max - i.points), 0));
  const needsYou = items.filter(
    (i) => i.status !== 'ok' && !readyIds.has(i.id) && (i.fix === 'you' || i.fix === 'google'),
  );

  const labelOf = (ref: FixRef) =>
    ref.type === 'change'
      ? KIND_LABEL[changes.find((c) => c.id === ref.id)?.kind ?? 'description']
      : ref.type === 'post'
        ? 'Google post'
        : 'Review reply';

  async function publish(refs: FixRef[], all: boolean) {
    setBusy(true);
    try {
      const r = await api<{
        results: (FixRef & { status: string; error: string | null })[];
        before: number | null;
        after: number | null;
      }>(`/api/clients/${clientId}/profile/publish`, {
        method: 'POST',
        body: { items: refs, all },
      });
      const failed = r.results
        .filter((x) => x.status === 'failed')
        .map((x) => ({ label: labelOf(x), error: x.error }));
      await onPublished({
        before: r.before,
        after: r.after,
        ok: r.results.length - failed.length,
        failed,
      });
      if (failed.length)
        notify('error', `${failed.length} item(s) could not be posted. See details at the top.`);
      else notify('success', all ? 'Everything was sent to Google ✓' : 'Posted on Google ✓');
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function postAll() {
    const ok = await confirm({
      title: `Post all ${total} improvements to Google?`,
      message:
        'Profile changes are applied now, review replies are posted now, and posts go out one at a time (first now, then every 3 days). You can undo profile changes later in the Google profile tab.',
      confirmLabel: 'Post all',
    });
    if (!ok) return;
    await publish(
      [
        ...changes.map((c) => ({ type: 'change' as const, id: c.id })),
        ...reviews.map((r) => ({ type: 'review' as const, id: r.id })),
        ...posts.map((p) => ({ type: 'post' as const, id: p.id })),
      ],
      true,
    );
  }

  return (
    <div className="space-y-6 pb-24">
      {result && (
        <Card className="border-green-200 bg-green-50">
          <div className="flex flex-wrap items-center gap-5">
            <ScoreRing score={result.after} from={result.before} size={96} />
            <div>
              <h3 className="text-lg font-bold text-green-800">
                🎉 {result.ok} improvement(s) sent to Google
              </h3>
              {result.before !== null && result.after !== null && (
                <p className="text-sm text-green-800">
                  Score {result.before} → <b>{result.after}</b>
                  {result.after > result.before && ` (+${result.after - result.before})`}. Some
                  changes may show “Google is reviewing” for 1-3 days.
                </p>
              )}
              {result.failed.map((f, i) => (
                <p key={i} className="mt-1 text-sm text-red-700">
                  ✗ {f.label}: {f.error}
                </p>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Score header */}
      <Card>
        <div className="flex flex-col items-center gap-6 sm:flex-row">
          <ScoreRing score={scan.score} from={data.previousScore} />
          <div className="flex-1 text-center sm:text-left">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Google Business Profile score
            </div>
            <h2 className="text-xl font-bold">
              {scan.score !== null ? verdict(scan.score) : 'Score unavailable'}
            </h2>
            {scan.projectedScore !== null &&
              scan.score !== null &&
              scan.projectedScore > scan.score && (
                <p className="mt-1 text-sm text-slate-600">
                  Post the ready AI fixes to reach{' '}
                  <b className="text-green-700">{scan.projectedScore}/100</b>.
                </p>
              )}
            <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs sm:justify-start">
              <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">
                ❌ {missing.length} missing
              </span>
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-800">
                ⚠ {improve.length} to improve
              </span>
              <span className="rounded-full bg-green-50 px-2.5 py-1 text-green-700">
                ✅ {ok.length} done
              </span>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Checked {relativeTime(scan.runAt)} ·{' '}
              <button className="text-[var(--brand)] hover:underline" onClick={onRescan}>
                Scan again
              </button>{' '}
              ·{' '}
              <button className="text-[var(--brand)] hover:underline" onClick={onCheckConnections}>
                Check connections
              </button>
            </p>
            {scan.status === 'partial' && scan.error && (
              <p className="mt-2 text-xs text-amber-700">Some checks were skipped: {scan.error}</p>
            )}
          </div>
        </div>
      </Card>

      {/* Checklist */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Checklist title="Missing" tone="red" items={missing} ready={readyIds} />
        <Checklist title="Can be improved" tone="amber" items={improve} ready={readyIds} />
      </div>

      {/* Fixes */}
      {total > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-bold">✨ {total} improvement(s) ready</h2>
              <p className="text-sm text-slate-500">
                Prepared by AI and from your website. Edit if you like, then click Post.
              </p>
            </div>
          </div>
          {changes.map((c) => (
            <ChangeFix
              key={c.id}
              clientId={clientId}
              change={c}
              gain={gainOf(FIX_ITEMS[c.kind] ?? [])}
              canPublish={data.canPublish}
              busy={busy}
              onPost={() => publish([{ type: 'change', id: c.id }], false)}
              reload={reload}
              notify={notify}
            />
          ))}
          {reviews.map((r) => (
            <ReviewFix
              key={r.id}
              clientId={clientId}
              review={r}
              gain={reviews.length ? Math.round(gainOf(FIX_ITEMS.replies!) / reviews.length) : 0}
              canPublish={data.canPublish}
              busy={busy}
              onPost={() => publish([{ type: 'review', id: r.id }], false)}
              reload={reload}
              notify={notify}
            />
          ))}
          {posts.map((p, i) => (
            <PostFix
              key={p.id}
              clientId={clientId}
              post={p}
              gain={i === 0 ? gainOf(FIX_ITEMS.posts!) : 0}
              canPublish={data.canPublish}
              busy={busy}
              onPost={() => publish([{ type: 'post', id: p.id }], false)}
              reload={reload}
              notify={notify}
            />
          ))}
        </div>
      ) : (
        <Card className="text-center">
          <p className="text-sm text-slate-600">
            🎉 No ready fixes right now. We will prepare new posts and improvements every week.
          </p>
        </Card>
      )}

      {/* Things only the owner / Google can do */}
      {needsYou.length > 0 && (
        <Card>
          <h3 className="font-semibold">Your to-do ({needsYou.length})</h3>
          <p className="text-sm text-slate-500">
            The app cannot do these for you, but each one raises your score.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
            {needsYou.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-start justify-between gap-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {i.status === 'missing' ? '❌' : '⚠'} {i.title}{' '}
                    <span className="text-xs text-green-700">
                      +{Math.round(i.max - i.points)} pts
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {i.detail} · {i.why}
                  </div>
                </div>
                <a
                  href="https://business.google.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-xs text-[var(--brand)] hover:underline"
                >
                  Open on Google ↗
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-medium">✅ Done ({ok.length})</summary>
        <ul className="mt-2 space-y-1 text-slate-600">
          {ok.map((i) => (
            <li key={i.id}>
              ✓ {i.title} <span className="text-xs text-slate-400">({i.detail})</span>
            </li>
          ))}
        </ul>
      </details>

      {/* Sticky "Post all" */}
      {total > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur print:hidden">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-slate-600">
              {total} ready
              {scan.score !== null && scan.projectedScore !== null && (
                <>
                  {' '}
                  · score <b>{scan.score}</b> →{' '}
                  <b className="text-green-700">{scan.projectedScore}</b>
                </>
              )}
            </span>
            <Button
              className="px-6"
              loading={busy}
              disabled={!data.canPublish}
              onClick={postAll}
              title={data.canPublish ? '' : 'Only the agency owner can post'}
            >
              🚀 Post all ({total})
            </Button>
          </div>
        </div>
      )}
      {!data.canPublish && total > 0 && (
        <Alert kind="info">
          Only the agency owner can post to Google. You can edit the drafts.
        </Alert>
      )}
      <p className="text-xs text-slate-400">Last scan: {formatDateTime(scan.runAt)}</p>
    </div>
  );
}

function Checklist({
  title,
  tone: t,
  items,
  ready,
}: {
  title: string;
  tone: 'red' | 'amber';
  items: ScoreItem[];
  ready: Set<string>;
}) {
  if (items.length === 0) return null;
  const border = t === 'red' ? 'border-red-200' : 'border-amber-200';
  const gain = Math.round(items.reduce((s, i) => s + (i.max - i.points), 0));
  return (
    <Card className={`p-0 ${border}`}>
      <div className="flex items-center justify-between px-4 pt-4">
        <h3 className="font-semibold">
          {t === 'red' ? '❌' : '⚠'} {title} ({items.length})
        </h3>
        <span className="text-xs font-medium text-green-700">up to +{gain} pts</span>
      </div>
      <ul className="mt-2 divide-y divide-slate-100">
        {items.map((i) => (
          <li key={i.id} className="px-4 py-2.5 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{i.title}</span>
              <span className="shrink-0">
                {ready.has(i.id) ? (
                  <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700">
                    ✨ fix ready
                  </span>
                ) : i.fix === 'google' ? (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    on Google
                  </span>
                ) : i.fix === 'you' ? (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                    needs you
                  </span>
                ) : null}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {i.detail} · <span className="text-slate-400">{i.why}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------ fix cards ------------------------------------

type CardProps = {
  clientId: string;
  gain: number;
  canPublish: boolean;
  busy: boolean;
  onPost: () => Promise<void>;
  reload: () => Promise<unknown>;
  notify: Notify;
};

function FixShell({
  title,
  gain,
  badge,
  error,
  children,
  canPublish,
  busy,
  onPost,
  onDismiss,
  extra,
}: {
  title: string;
  gain: number;
  badge?: string;
  error?: string | null;
  children: React.ReactNode;
  canPublish: boolean;
  busy: boolean;
  onPost: () => void;
  onDismiss: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{title}</h3>
          {badge && (
            <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">
              {badge}
            </span>
          )}
        </div>
        {gain > 0 && <span className="text-xs font-semibold text-green-700">+{gain} pts</span>}
      </div>
      {error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">Last try failed: {error}</p>
      )}
      <div className="mt-3">{children}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button loading={busy} disabled={!canPublish} onClick={onPost}>
          Post ✓
        </Button>
        {extra}
        <button className="ml-auto text-xs text-slate-500 hover:underline" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </Card>
  );
}

async function dismiss(
  clientId: string,
  ref: FixRef,
  reload: () => Promise<unknown>,
  notify: Notify,
) {
  try {
    await api(`/api/clients/${clientId}/profile/dismiss`, { method: 'POST', body: ref });
    await reload();
  } catch (e) {
    notify('error', (e as Error).message);
  }
}

const listOf = (v: unknown, key: string) =>
  Array.isArray(v) ? (v as Record<string, unknown>[]).map((x) => String(x[key] ?? '')) : [];

function ChangeFix({
  clientId,
  change,
  gain,
  canPublish,
  busy,
  onPost,
  reload,
  notify,
}: CardProps & { change: Change }) {
  const [after, setAfter] = useState(change.after);
  const [dirty, setDirty] = useState(false);
  const save = async () => {
    await api(`/api/clients/${clientId}/gbp/changes/${change.id}`, {
      method: 'PATCH',
      body: { after },
    });
    setDirty(false);
  };
  const before = change.before ?? {};
  let body: React.ReactNode = null;

  if (change.kind === 'description') {
    const text = String(after.description ?? '');
    body = (
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">Now</div>
          <p className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm text-slate-600">
            {String(before.description ?? '') || <i>(empty)</i>}
          </p>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs font-medium text-slate-500">
            <span>New</span>
            <span>{text.length}/750</span>
          </div>
          <textarea
            className={`${inputClass} min-h-36`}
            value={text}
            maxLength={750}
            onChange={(e) => {
              setAfter({ description: e.target.value });
              setDirty(true);
            }}
            aria-label="New description"
          />
        </div>
      </div>
    );
  } else if (change.kind === 'services' || change.kind === 'categories') {
    const key = change.kind === 'services' ? 'services' : 'additionalCategories';
    const label = change.kind === 'services' ? 'label' : 'displayName';
    const had = new Set(listOf(before[key], label).map((x) => x.toLowerCase()));
    const list = (after[key] as Record<string, unknown>[]) ?? [];
    body = (
      <div className="flex flex-wrap gap-2">
        {list.map((x, i) => {
          const name = String(x[label] ?? '');
          const isNew = !had.has(name.toLowerCase());
          return (
            <span
              key={`${name}-${i}`}
              className={`rounded-full px-3 py-1 text-xs ${isNew ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}
            >
              {isNew ? '+ ' : ''}
              {name}
              {isNew && (
                <button
                  className="ml-2 hover:text-red-600"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    setAfter({ [key]: list.filter((_, j) => j !== i) });
                    setDirty(true);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
    );
  } else if (change.kind === 'hours') {
    const hours = (after.hours as { day: string; open: string; close: string }[]) ?? [];
    body = (
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d) => {
          const h = hours.filter((x) => x.day === d);
          return (
            <li key={d} className="flex justify-between gap-4 rounded bg-slate-50 px-2 py-1">
              <span className="text-slate-500">{d.charAt(0) + d.slice(1).toLowerCase()}</span>
              <span>{h.length ? h.map((x) => `${x.open}–${x.close}`).join(', ') : 'Closed'}</span>
            </li>
          );
        })}
      </ul>
    );
  } else if (change.kind === 'website') {
    body = (
      <p className="text-sm">
        Add <b>{String(after.websiteUri ?? '')}</b> to the listing.
      </p>
    );
  } else if (change.kind === 'attributes') {
    const list = (after.attributes as { name: string; value: boolean }[]) ?? [];
    body = (
      <ul className="space-y-1 text-sm">
        {list.map((a, i) => (
          <li key={a.name} className="flex items-center justify-between gap-3">
            <span>{a.name.replace('attributes/', '').replace(/_/g, ' ')}</span>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={a.value}
                onChange={(e) => {
                  setAfter({
                    attributes: list.map((x, j) =>
                      j === i ? { ...x, value: e.target.checked } : x,
                    ),
                  });
                  setDirty(true);
                }}
              />
              {a.value ? 'Yes' : 'No'}
            </label>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <FixShell
      title={KIND_LABEL[change.kind]}
      gain={gain}
      badge={change.source === 'website' ? 'from your website' : '✨ AI'}
      error={change.status === 'failed' ? change.error : null}
      canPublish={canPublish}
      busy={busy}
      onPost={async () => {
        try {
          if (dirty) await save();
          await onPost();
        } catch (e) {
          notify('error', (e as Error).message);
        }
      }}
      onDismiss={() => dismiss(clientId, { type: 'change', id: change.id }, reload, notify)}
    >
      {change.reason && <p className="mb-2 text-sm text-slate-500">{change.reason}</p>}
      {body}
    </FixShell>
  );
}

function ReviewFix({
  clientId,
  review,
  gain,
  canPublish,
  busy,
  onPost,
  reload,
  notify,
}: CardProps & { review: ReviewDraft }) {
  const [text, setText] = useState(review.draft);
  return (
    <FixShell
      title={`Reply to ${review.reviewerName ?? 'a customer'}`}
      gain={gain}
      badge="✨ AI"
      canPublish={canPublish}
      busy={busy}
      onPost={async () => {
        try {
          if (text !== review.draft)
            await api(`/api/clients/${clientId}/profile/review-drafts/${review.id}`, {
              method: 'PATCH',
              body: { text },
            });
          await onPost();
        } catch (e) {
          notify('error', (e as Error).message);
        }
      }}
      onDismiss={() => dismiss(clientId, { type: 'review', id: review.id }, reload, notify)}
    >
      <p className="text-sm">
        <span className="text-amber-500">{'★'.repeat(review.starRating ?? 0)}</span>{' '}
        <span className="text-slate-600">{review.comment || <i>(rating only)</i>}</span>
      </p>
      <textarea
        className={`${inputClass} mt-2 min-h-20`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={4000}
        aria-label="Reply"
      />
    </FixShell>
  );
}

function PostFix({
  clientId,
  post,
  gain,
  canPublish,
  busy,
  onPost,
  reload,
  notify,
}: CardProps & { post: Post }) {
  const [text, setText] = useState(post.summary);
  return (
    <FixShell
      title="Google post"
      gain={gain}
      badge="✨ AI"
      error={post.status === 'failed' ? post.error : null}
      canPublish={canPublish}
      busy={busy}
      onPost={async () => {
        try {
          if (text !== post.summary) {
            await api(`/api/clients/${clientId}/gbp/posts/${post.id}`, {
              method: 'PATCH',
              body: { summary: text, actionType: post.actionType, actionUrl: post.actionUrl },
            });
          }
          await onPost();
        } catch (e) {
          notify('error', (e as Error).message);
        }
      }}
      onDismiss={() => dismiss(clientId, { type: 'post', id: post.id }, reload, notify)}
    >
      <textarea
        className={`${inputClass} min-h-24`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={1500}
        aria-label="Post text"
      />
      {post.actionType && (
        <p className="mt-1 text-xs text-slate-500">
          Button: {post.actionType.replace('_', ' ').toLowerCase()}
          {post.actionUrl ? ` → ${post.actionUrl}` : ''}
        </p>
      )}
    </FixShell>
  );
}
