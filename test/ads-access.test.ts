// Google Ads access model after the developer-token sunset (Sep 2026): OAuth token only,
// optional login-customer-id for manager accounts, readable errors for Cloud project access levels.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adsBaseUrl,
  adsHeaders,
  AdsAccessError,
  DEFAULT_ADS_API_VERSION,
  explainAdsError,
  gaql,
} from '../src/google/ads';
import { GoogleApiError, retryConfig } from '../src/google/http';

afterEach(() => vi.unstubAllGlobals());

describe('Google Ads request setup', () => {
  it('never sends a developer-token header', () => {
    expect(adsHeaders({})).toEqual({});
    expect(Object.keys(adsHeaders({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890' }))).not.toContain(
      'developer-token',
    );
  });

  it('sends login-customer-id (digits only) when a manager account is configured', () => {
    expect(adsHeaders({ GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890' })).toEqual({
      'login-customer-id': '1234567890',
    });
  });

  it('defaults to API v26 and allows an override', () => {
    expect(DEFAULT_ADS_API_VERSION).toBe('v26');
    expect(adsBaseUrl({})).toBe('https://googleads.googleapis.com/v26');
    expect(adsBaseUrl({ GOOGLE_ADS_API_VERSION: 'v27' })).toBe(
      'https://googleads.googleapis.com/v27',
    );
  });

  it('calls googleAds:search with only the OAuth bearer token (no developer token)', async () => {
    retryConfig.baseDelayMs = 1;
    let seen: Record<string, string> = {};
    let url = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      seen = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ results: [{ customer: { currencyCode: 'INR' } }] }), {
        status: 200,
      });
    });
    const rows = await gaql<{ customer: { currencyCode: string } }>(
      {},
      'oauth-access-token',
      '1234567890',
      'SELECT customer.currency_code FROM customer',
    );
    expect(rows[0]?.customer.currencyCode).toBe('INR');
    expect(url).toBe('https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search');
    expect(seen.Authorization).toBe('Bearer oauth-access-token');
    expect(Object.keys(seen).map((k) => k.toLowerCase())).not.toContain('developer-token');
  });
});

describe('Google Ads access errors', () => {
  it('explains a Test-access project calling a production account (v25+ and older error codes)', () => {
    for (const reason of ['CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'ACTION_NOT_PERMITTED']) {
      expect(() => explainAdsError(new GoogleApiError(403, reason, 'denied'))).toThrow(
        AdsAccessError,
      );
      expect(() => explainAdsError(new GoogleApiError(403, reason, 'denied'))).toThrow(
        /Explorer access/,
      );
    }
  });

  it('explains a disabled Google Ads API', () => {
    expect(() =>
      explainAdsError(
        new GoogleApiError(
          403,
          'SERVICE_DISABLED',
          'Google Ads API has not been used in project 91010309450',
        ),
      ),
    ).toThrow(/not enabled/);
  });

  it('passes other errors through unchanged', () => {
    const e = new GoogleApiError(500, 'INTERNAL', 'boom');
    expect(() => explainAdsError(e)).toThrow(e);
  });
});
