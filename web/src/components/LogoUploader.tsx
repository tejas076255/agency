import { useRef, useState } from 'react';
import { api, type Agency } from '../lib/api';
import { Alert, Button } from './ui';

const MAX_BYTES = 512 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp';

export function LogoUploader({
  agency,
  onChange,
}: {
  agency: Agency;
  onChange: (a: Agency) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) return setError('Logo must be 512 KB or smaller.');
    if (!ACCEPT.split(',').includes(file.type)) return setError('Use a PNG, JPEG or WebP image.');
    const form = new FormData();
    form.append('logo', file);
    setBusy(true);
    try {
      const res = await api<{ agency: Agency }>('/api/agency/logo', { method: 'POST', form });
      onChange(res.agency);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ agency: Agency }>('/api/agency/logo', { method: 'DELETE' });
      onChange(res.agency);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove logo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {agency.logoUrl ? (
            <img src={agency.logoUrl} alt="Agency logo" className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs text-slate-400">No logo</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            loading={busy}
            onClick={() => input.current?.click()}
          >
            {agency.logoUrl ? 'Change logo' : 'Upload logo'}
          </Button>
          {agency.logoUrl && (
            <Button type="button" variant="danger" disabled={busy} onClick={remove}>
              Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      <p className="text-xs text-slate-500">
        PNG, JPEG or WebP, max 512 KB. Square logos look best.
      </p>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
