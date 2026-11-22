// Business Profile 403 debugging: which call failed, full error details, reviews path, scopes, roles.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchGbpSummary, gbpReviewsPath, GbpSyncError } from '../src/google/business';
import { googleRequest, GoogleApiError, retryConfig } from '../src/google/http';
import { runGbpDiagnostics } from '../src/jobs/gbp-diagnostics';

const ACCOUNT = 'accounts/104549098573635444181';
const LOCATION = 'locations/17858321857004435438';
const DENIED = {
  error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  retryConfig.baseDelayMs = 1;
});
afterEach(() => vi.unstubAllGlobals());

describe('reviews path', () => {
  it('uses accounts/{accountId}/locations/{locationId}', () => {
    expect(gbpReviewsPath(ACCOUNT, LOCATION)).toBe(`${ACCOUNT}/${LOCATION}`);
  });
  it('rejects malformed names', () => {
    expect(() => gbpReviewsPath('104549098573635444181', LOCATION)).toThrow();
    expect(() => gbpReviewsPath(ACCOUNT, 'locations/abc')).toThrow();
  });
});

describe('GoogleApiError keeps debugging details', () => {
  it('records method + URL (secrets redacted) and the raw response body', async () => {
    vi.stubGlobal('fetch', async () => json(DENIED, 403));
    const err = await googleRequest(
      'https://example.googleapis.com/v1/x?key=AIzaSyFAKE0000000000000000000000000000',
      {
        retries: 0,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    const g = err as GoogleApiError;
    expect(g.status).toBe(403);
    expect(g.reason).toBe('PERMISSION_DENIED');
    expect(g.endpoint).toMatch(/^GET https:\/\/example\.googleapis\.com\/v1\/x\?key=\[REDACTED\]$/);
    expect(g.body).toContain('The caller does not have permission');
  });
});

describe('fetchGbpSummary reports exactly which call failed', () => {
  it('returns partial data when only the v4 reviews call is denied', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('mybusinessbusinessinformation'))
        return json({ name: LOCATION, title: 'Upmark' });
      if (url.includes('businessprofileperformance'))
        return json({ multiDailyMetricTimeSeries: [] });
      if (url.includes('mybusiness.googleapis.com/v4')) return json(DENIED, 403);
      return json({}, 404);
    });
    const r = await fetchGbpSummary('token', ACCOUNT, LOCATION);
    expect(r.summary.location.title).toBe('Upmark');
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      call: 'reviews',
      status: 403,
      reason: 'PERMISSION_DENIED',
    });
    expect(r.failures[0]!.endpoint).toContain(`/v4/${ACCOUNT}/${LOCATION}/reviews`);
    expect(r.failures[0]!.body).toContain('caller does not have permission');
    expect(calls.some((u) => u.includes(`/v4/${ACCOUNT}/${LOCATION}/reviews`))).toBe(true);
  });

  it('throws GbpSyncError listing all three calls when everything is denied', async () => {
    vi.stubGlobal('fetch', async () => json(DENIED, 403));
    const err = await fetchGbpSummary('token', ACCOUNT, LOCATION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GbpSyncError);
    const e = err as GbpSyncError;
    expect(e.failures.map((f) => f.call).sort()).toEqual([
      'business_information',
      'performance',
      'reviews',
    ]);
    expect(e.message).toMatch(
      /My Business API v4 \(accounts\.locations\.reviews\.list\) failed: 403 PERMISSION_DENIED/,
    );
  });
});

describe('runGbpDiagnostics', () => {
  it('shows scopes, accounts, the user role per location, probes and hints', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/tokeninfo') {
        return json({ scope: 'https://www.googleapis.com/auth/business.manage openid' });
      }
      // v4 reviews first: its URL also contains "/accounts/.../locations".
      if (url.includes('mybusiness.googleapis.com/v4')) return json(DENIED, 403);
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?')) {
        return json({
          accounts: [
            { name: ACCOUNT, accountName: 'Upmark', type: 'PERSONAL', role: 'PRIMARY_OWNER' },
          ],
        });
      }
      if (url.includes(`/${ACCOUNT}/locations`))
        return json({ locations: [{ name: LOCATION, title: 'Upmark' }] });
      if (url.endsWith(`/${LOCATION}/admins`)) {
        return json({ admins: [{ admin: 'info.upmark.in@gmail.com', role: 'SITE_MANAGER' }] });
      }
      if (url.includes('mybusinessbusinessinformation')) return json({ name: LOCATION });
      if (url.includes('businessprofileperformance')) return json(DENIED, 403);
      if (url.includes('mybusiness.googleapis.com/v4')) return json(DENIED, 403);
      return json({}, 404);
    });
    const r = await runGbpDiagnostics('token', 'info.upmark.in@gmail.com', {
      accountName: ACCOUNT,
      locationName: LOCATION,
    });
    expect(r.token.hasBusinessManage).toBe(true);
    expect(r.selected.reviewsPath).toBe(`${ACCOUNT}/${LOCATION}/reviews`);
    expect(r.accounts[0]).toMatchObject({ type: 'PERSONAL', role: 'PRIMARY_OWNER' });
    expect(r.accounts[0]!.locations[0]!.yourRole).toBe('SITE_MANAGER');
    expect(r.probes.map((p) => [p.call, p.ok])).toEqual([
      ['business_information', true],
      ['performance', false],
      ['reviews', false],
    ]);
    expect(r.probes[2]!.failure?.body).toContain('caller does not have permission');
    const hints = r.hints.join('\n');
    expect(hints).toMatch(/Your role on this location is SITE_MANAGER/);
    expect(hints).toMatch(/Google My Business API/);
  });

  it('flags a token without business.manage', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/tokeninfo') return json({ scope: 'openid email' });
      if (url.includes('mybusinessaccountmanagement')) return json({ accounts: [] });
      return json({}, 404);
    });
    const r = await runGbpDiagnostics('token', 'a@b.com', {
      accountName: null,
      locationName: null,
    });
    expect(r.token.hasBusinessManage).toBe(false);
    expect(r.hints.join(' ')).toMatch(/does not include business\.manage/);
  });
});
