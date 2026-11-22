// Client "AI tools" tab: SEO assistant chat, content writer, Google Ads copy and anomaly alerts.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, inputClass } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AiLanguage, AlertRow } from '../lib/types';

type Notify = (kind: 'success' | 'error' | 'info', text: string) => void;
type Msg = { role: 'user' | 'assistant'; content: string };

const LANGS: { id: AiLanguage; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hinglish', label: 'Hinglish' },
  { id: 'hi', label: 'Hindi' },
];
const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm';

function LanguageSelect({
  value,
  onChange,
}: {
  value: AiLanguage;
  onChange: (v: AiLanguage) => void;
}) {
  return (
    <select
      className={selectClass}
      value={value}
      onChange={(e) => onChange(e.target.value as AiLanguage)}
      aria-label="Language"
    >
      {LANGS.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 text-xs text-[var(--brand)] hover:underline"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <Card>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{sub}</p>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function AiTab({ clientId, notify }: { clientId: string; notify: Notify }) {
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const refreshUsage = useCallback(() => {
    api<{ used: number; limit: number }>('/api/ai/usage')
      .then(setUsage)
      .catch(() => undefined);
  }, []);
  useEffect(refreshUsage, [refreshUsage]);

  return (
    <div className="space-y-6">
      <Alert kind="info">
        AI writes drafts from this client’s data. Always read and edit before using anything
        publicly.
        {usage && (
          <span className="ml-1">
            AI requests today: <b>{usage.used}</b> / {usage.limit}.
          </span>
        )}
      </Alert>
      <AlertsCard clientId={clientId} />
      <AssistantCard clientId={clientId} onUsed={refreshUsage} />
      <ContentWriterCard clientId={clientId} notify={notify} onUsed={refreshUsage} />
      <AdCopyCard clientId={clientId} notify={notify} onUsed={refreshUsage} />
    </div>
  );
}

// ------------------------------------ alerts ------------------------------------

export function AlertItem({ a, showClient = false }: { a: AlertRow; showClient?: boolean }) {
  return (
    <li
      className={`border-l-4 px-4 py-3 ${a.severity === 'high' ? 'border-red-500' : 'border-amber-500'} ${a.read ? 'bg-white' : 'bg-amber-50/40'}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${a.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}
        >
          {a.severity === 'high' ? 'High' : 'Medium'}
        </span>
        {showClient && a.clientName && (
          <Link
            to={`/clients/${a.clientId}`}
            className="font-medium text-[var(--brand)] hover:underline"
          >
            {a.clientName}:
          </Link>
        )}
        <span className="font-medium">{a.title}</span>
      </div>
      {a.explanation && (
        <p className="mt-1 text-sm text-slate-600">
          {a.explanationSource === 'ai' && <span title="Written by AI">✨ </span>}
          {a.explanation}
        </p>
      )}
      <p className="mt-1 text-xs text-slate-400">
        {formatDateTime(a.createdAt)}
        {a.emailed && ' · emailed'}
      </p>
    </li>
  );
}

function AlertsCard({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  useEffect(() => {
    api<{ alerts: AlertRow[] }>(`/api/clients/${clientId}/alerts`)
      .then((r) => setRows(r.alerts))
      .catch(() => setRows([]));
  }, [clientId]);
  return (
    <Card className="p-0">
      <div className="px-5 pt-5">
        <h3 className="font-semibold">Smart alerts</h3>
        <p className="mt-1 text-sm text-slate-500">
          Every weekly health check looks for big drops (clicks, visits, leads, keywords, speed,
          score), negative reviews and ad overspend. AI explains the likely cause. Owners get an
          email when the agency Google account is connected.
        </p>
      </div>
      {rows === null ? (
        <p className="px-5 py-4 text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">No alerts yet. 🎉</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.slice(0, 10).map((a) => (
            <AlertItem key={a.id} a={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------ assistant ------------------------------------

const QUICK_QUESTIONS = [
  'Is client ki website ka overall haal kya hai?',
  'Traffic kyun gira ya badha? Main wajah batao.',
  'Kaunse keywords page 1 par jaldi aa sakte hain?',
  'Is hafte sabse pehle kaunse 3 kaam karne chahiye?',
];

function AssistantCard({ clientId, onUsed }: { clientId: string; onUsed: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next = [...messages, { role: 'user' as const, content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ reply: string }>(`/api/clients/${clientId}/ai/assistant`, {
        method: 'POST',
        body: { messages: next.slice(-12) },
      });
      setMessages([...next, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onUsed();
    }
  }

  return (
    <Section
      title="✨ AI SEO assistant"
      sub="Ask anything about this client. Answers use the latest health check, keywords, reviews, ads and alerts. Chat is not saved."
    >
      <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg bg-slate-50 p-3">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => ask(q)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:border-[var(--brand)] hover:text-[var(--brand)]"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === 'user'
                  ? 'bg-[var(--brand)] text-white'
                  : 'border border-slate-200 bg-white'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && <p className="text-xs text-slate-400">Thinking…</p>}
        <div ref={endRef} />
      </div>
      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <input
          className={inputClass}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your question (English or Hinglish)…"
          maxLength={2000}
          aria-label="Question for the AI assistant"
        />
        <Button type="submit" loading={busy} disabled={!input.trim()}>
          Ask
        </Button>
        {messages.length > 0 && (
          <Button type="button" variant="secondary" onClick={() => setMessages([])}>
            Clear
          </Button>
        )}
      </form>
    </Section>
  );
}

// ------------------------------------ content writer ------------------------------------

type ContentType = 'meta_tags' | 'blog_outline' | 'blog_post' | 'gbp_post';
type ContentResult =
  | { type: 'meta_tags'; data: { titles: string[]; descriptions: string[] } }
  | {
      type: 'blog_outline';
      data: {
        title: string;
        sections: { heading: string; points: string[] }[];
        faq: { q: string; a: string }[];
      };
    }
  | {
      type: 'blog_post';
      data: { title: string; meta_description: string; content_markdown: string };
    }
  | { type: 'gbp_post'; data: { posts: { text: string; call_to_action: string }[] } };

const CONTENT_TYPES: { id: ContentType; label: string }[] = [
  { id: 'meta_tags', label: 'SEO title + meta description' },
  { id: 'blog_outline', label: 'Blog outline + FAQs' },
  { id: 'blog_post', label: 'Full blog post' },
  { id: 'gbp_post', label: 'Google Business Profile posts' },
];

function ContentWriterCard({
  clientId,
  notify,
  onUsed,
}: {
  clientId: string;
  notify: Notify;
  onUsed: () => void;
}) {
  const [type, setType] = useState<ContentType>('meta_tags');
  const [keyword, setKeyword] = useState('');
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContentResult | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    api<{ keywords: { keyword: string }[]; suggestions: { keyword: string }[] }>(
      `/api/clients/${clientId}/keywords`,
    )
      .then((r) =>
        setSuggestions([...r.keywords, ...r.suggestions].map((k) => k.keyword).slice(0, 30)),
      )
      .catch(() => undefined);
  }, [clientId]);

  async function generate() {
    setBusy(true);
    setResult(null);
    try {
      setResult(
        await api<ContentResult>(`/api/clients/${clientId}/ai/content`, {
          method: 'POST',
          body: { type, keyword, language, notes: notes || undefined },
        }),
      );
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
      onUsed();
    }
  }

  return (
    <Section
      title="✍️ AI content writer"
      sub="SEO titles, meta descriptions, blog outlines, full blog posts and Google Business Profile posts for a keyword."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">What to write</span>
          <select
            className={`${selectClass} w-full`}
            value={type}
            onChange={(e) => setType(e.target.value as ContentType)}
          >
            {CONTENT_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">Main keyword</span>
          <input
            className={inputClass}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            list={`kw-${clientId}`}
            placeholder="e.g. dentist in kothrud"
            maxLength={120}
          />
          <datalist id={`kw-${clientId}`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-slate-600">
          Facts about the business (optional): services, area, offers, USP
        </span>
        <textarea
          className={`${inputClass} min-h-16`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1500}
          placeholder="e.g. Open 7 days, 15 years experience, painless root canal, near Kothrud depot"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <LanguageSelect value={language} onChange={setLanguage} />
        <Button loading={busy} disabled={keyword.trim().length < 2} onClick={generate}>
          Generate
        </Button>
        {busy && type === 'blog_post' && (
          <span className="text-xs text-slate-400">A full post can take up to a minute…</span>
        )}
      </div>
      {result && <ContentOutput result={result} />}
    </Section>
  );
}

function ContentOutput({ result }: { result: ContentResult }) {
  const box = 'mt-4 space-y-3 rounded-lg border border-slate-200 p-4 text-sm';
  if (result.type === 'meta_tags') {
    return (
      <div className={box}>
        <h4 className="font-medium">Title tags</h4>
        {result.data.titles.map((t) => (
          <div key={t} className="flex items-start justify-between gap-3">
            <span>
              {t} <span className="text-xs text-slate-400">({t.length})</span>
            </span>
            <CopyButton text={t} />
          </div>
        ))}
        <h4 className="pt-2 font-medium">Meta descriptions</h4>
        {result.data.descriptions.map((d) => (
          <div key={d} className="flex items-start justify-between gap-3">
            <span>
              {d} <span className="text-xs text-slate-400">({d.length})</span>
            </span>
            <CopyButton text={d} />
          </div>
        ))}
      </div>
    );
  }
  if (result.type === 'blog_outline') {
    const text = [
      `# ${result.data.title}`,
      ...result.data.sections.flatMap((s) => [
        `\n## ${s.heading}`,
        ...s.points.map((p) => `- ${p}`),
      ]),
      '\n## FAQ',
      ...result.data.faq.flatMap((f) => [`**${f.q}**`, f.a]),
    ].join('\n');
    return (
      <div className={box}>
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-base font-semibold">{result.data.title}</h4>
          <CopyButton text={text} label="Copy all" />
        </div>
        {result.data.sections.map((s) => (
          <div key={s.heading}>
            <h5 className="font-medium">{s.heading}</h5>
            <ul className="ml-5 list-disc text-slate-600">
              {s.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
        {result.data.faq.length > 0 && (
          <div>
            <h5 className="font-medium">FAQ</h5>
            {result.data.faq.map((f) => (
              <p key={f.q} className="mt-1 text-slate-600">
                <b>{f.q}</b> {f.a}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (result.type === 'blog_post') {
    return (
      <div className={box}>
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-base font-semibold">{result.data.title}</h4>
          <CopyButton text={result.data.content_markdown} label="Copy post (Markdown)" />
        </div>
        <p className="text-xs text-slate-500">
          Meta description: {result.data.meta_description}{' '}
          <CopyButton text={result.data.meta_description} />
        </p>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-sans text-slate-700">
          {result.data.content_markdown}
        </pre>
      </div>
    );
  }
  return (
    <div className={box}>
      {result.data.posts.map((p, i) => (
        <div key={i} className="rounded bg-slate-50 p-3">
          <div className="flex items-start justify-between gap-3">
            <span className="text-xs font-medium text-slate-500">
              Post {i + 1} · button: {p.call_to_action.replace('_', ' ').toLowerCase()}
            </span>
            <CopyButton text={p.text} />
          </div>
          <p className="mt-1 whitespace-pre-wrap">{p.text}</p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------ ad copy ------------------------------------

type AdCopy = {
  headlines: string[];
  descriptions: string[];
  negativeKeywords: string[];
  tips: string[];
  basedOnAdsData: boolean;
};

function AdCopyCard({
  clientId,
  notify,
  onUsed,
}: {
  clientId: string;
  notify: Notify;
  onUsed: () => void;
}) {
  const [product, setProduct] = useState('');
  const [notes, setNotes] = useState('');
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<AdCopy | null>(null);

  async function generate() {
    setBusy(true);
    setCopy(null);
    try {
      setCopy(
        await api<AdCopy>(`/api/clients/${clientId}/ai/ad-copy`, {
          method: 'POST',
          body: { product: product || undefined, notes: notes || undefined, language },
        }),
      );
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
      onUsed();
    }
  }

  return (
    <Section
      title="📣 AI Google Ads copy"
      sub="15 headlines (max 30 characters) and 4 descriptions (max 90) for a Responsive Search Ad, plus negative keywords from wasted search terms when Google Ads is connected."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <input
          className={inputClass}
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          placeholder="Service / product to advertise, e.g. teeth whitening"
          maxLength={200}
          aria-label="Service or product"
        />
        <input
          className={inputClass}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Facts / offer (optional), e.g. free consultation, Pune"
          maxLength={1000}
          aria-label="Facts or offer"
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <LanguageSelect value={language} onChange={setLanguage} />
        <Button loading={busy} onClick={generate}>
          Generate ad copy
        </Button>
      </div>
      {copy && (
        <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Headlines ({copy.headlines.length})</h4>
              <CopyButton text={copy.headlines.join('\n')} label="Copy all" />
            </div>
            <ul className="mt-2 space-y-1">
              {copy.headlines.map((h) => (
                <li key={h} className="flex justify-between gap-2">
                  <span>{h}</span>
                  <span className="text-xs tabular-nums text-slate-400">{h.length}/30</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">Descriptions</h4>
                <CopyButton text={copy.descriptions.join('\n')} label="Copy all" />
              </div>
              <ul className="mt-2 space-y-2">
                {copy.descriptions.map((d) => (
                  <li key={d}>
                    {d} <span className="text-xs tabular-nums text-slate-400">{d.length}/90</span>
                  </li>
                ))}
              </ul>
            </div>
            {copy.negativeKeywords.length > 0 && (
              <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium">Negative keywords</h4>
                  <CopyButton text={copy.negativeKeywords.join('\n')} label="Copy all" />
                </div>
                <p className="mt-2 text-slate-600">{copy.negativeKeywords.join(', ')}</p>
              </div>
            )}
            {copy.tips.length > 0 && (
              <div className="rounded-lg border border-slate-200 p-4">
                <h4 className="font-medium">Tips</h4>
                <ul className="ml-5 mt-2 list-disc text-slate-600">
                  {copy.tips.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            {!copy.basedOnAdsData && (
              <p className="text-xs text-slate-400">
                Google Ads is not connected for this client, so this copy is not based on campaign
                data.
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}
