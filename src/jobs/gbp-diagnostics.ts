// Business Profile diagnostics (owner-only). Runs inside the Worker so OAuth tokens never leave it:
// token scopes, accounts + the user's role, locations + the user's role per location (Account
// Management API), and a live probe of each call the sync makes, with Google's full error response.
import { comparePeriods } from '../lib/dates';
import {
  GBP_CALL_LABEL,
  gbpInfoUrl,
  gbpPerformanceUrl,
  gbpReviewsPath,
  listGbpAccounts,
  listGbpLocations,
  toCallFailure,
  type GbpCallFailure,
} from '../google/business';
import { googleRequest } from '../google/http';
import { SCOPE } from '../google/tokens';

type Admin = { name?: string; admin?: string; account?: string; role?: string };

export type GbpDiagnostics = {
  checkedAt: number;
  connectedEmail: string;
  token: { scopes: string[]; hasBusinessManage: boolean; error?: string };
  selected: { accountName: string | null; locationName: string | null; reviewsPath: string | null };
  accounts: {
    name: string;
    accountName: string;
    type: string | null;
    role: string | null;
    verificationState: string | null;
    locations: {
      name: string;
      title: string;
      yourRole: string | null;
      admins: { admin: string; role: string }[];
      adminsError?: string;
    }[];
    locationsError?: string;
  }[];
  accountsError?: string;
  probes: {
    call: GbpCallFailure['call'];
    label: string;
    ok: boolean;
    endpoint: string;
    failure?: GbpCallFailure;
  }[];
  /** Status of the selected location from Business Information metadata. */
  locationStatus?: {
    title: string | null;
    verifiedOwnerControl: boolean | null;
    duplicateOf: string | null;
    openStatus: string | null;
    mapsUri: string | null;
  };
  hints: string[];
};

type LocationMeta = {
  title?: string;
  openInfo?: { status?: string };
  metadata?: { hasVoiceOfMerchant?: boolean; duplicateLocation?: string; mapsUri?: string };
};

function errText(e: unknown): string {
  const f = toCallFailure('business_information', e);
  return `${f.status ?? ''} ${f.reason}: ${f.message}${f.body ? ` | response: ${f.body}` : ''}`.trim();
}

/** Token scopes via Google's tokeninfo endpoint (POST, so the token is not put in a URL). */
async function tokenScopes(token: string): Promise<{ scopes: string[]; error?: string }> {
  try {
    const r = await googleRequest<{ scope?: string }>('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({ access_token: token }).toString(),
      retries: 0,
    });
    return { scopes: (r.scope ?? '').split(' ').filter(Boolean) };
  } catch (e) {
    return { scopes: [], error: errText(e) };
  }
}

function safeReviewsPath(accountName: string | null, locationName: string | null): string | null {
  if (!accountName || !locationName) return null;
  try {
    return `${gbpReviewsPath(accountName, locationName)}/reviews`;
  } catch {
    return null;
  }
}

export async function runGbpDiagnostics(
  token: string,
  connectedEmail: string,
  selected: { accountName: string | null; locationName: string | null },
): Promise<GbpDiagnostics> {
  const hints: string[] = [];
  const tok = await tokenScopes(token);
  const hasBusinessManage = tok.scopes.includes(SCOPE.business);
  if (!tok.error && !hasBusinessManage) {
    hints.push(
      'The access token does not include business.manage: disconnect and connect Business Profile again, allowing all permissions.',
    );
  }

  const out: GbpDiagnostics = {
    checkedAt: Date.now(),
    connectedEmail,
    token: { scopes: tok.scopes, hasBusinessManage, ...(tok.error ? { error: tok.error } : {}) },
    selected: {
      ...selected,
      reviewsPath: safeReviewsPath(selected.accountName, selected.locationName),
    },
    accounts: [],
    probes: [],
    hints,
  };

  // 1) Accounts, their locations, and the user's role on each location.
  try {
    const accounts = await listGbpAccounts(token);
    for (const a of accounts.slice(0, 10)) {
      const entry: GbpDiagnostics['accounts'][number] = {
        name: a.name,
        accountName: a.accountName,
        type: a.type ?? null,
        role: a.role ?? null,
        verificationState: a.verificationState ?? null,
        locations: [],
      };
      try {
        const locs = await listGbpLocations(token, a.name);
        for (const l of locs.slice(0, 20)) {
          const loc: GbpDiagnostics['accounts'][number]['locations'][number] = {
            name: l.name,
            title: l.title,
            yourRole: null,
            admins: [],
          };
          try {
            const r = await googleRequest<{ admins?: Admin[] }>(
              `https://mybusinessaccountmanagement.googleapis.com/v1/${l.name}/admins`,
              { accessToken: token, retries: 0 },
            );
            loc.admins = (r.admins ?? []).map((x) => ({
              admin: x.admin ?? x.account ?? x.name ?? '?',
              role: x.role ?? '?',
            }));
            const me = loc.admins.find(
              (x) => x.admin.toLowerCase() === connectedEmail.toLowerCase(),
            );
            loc.yourRole = me?.role ?? null;
          } catch (e) {
            loc.adminsError = errText(e);
          }
          entry.locations.push(loc);
        }
      } catch (e) {
        entry.locationsError = errText(e);
      }
      out.accounts.push(entry);
    }
  } catch (e) {
    out.accountsError = errText(e);
    hints.push(
      'Listing accounts failed: check that the "My Business Account Management API" is enabled and Business Profile API access is approved for this Cloud project.',
    );
  }

  // 2) Probe the three calls the sync makes, for the selected location.
  const { accountName, locationName } = selected;
  if (accountName && locationName) {
    const period = comparePeriods(Date.now(), 3);
    const reviewsUrl = out.selected.reviewsPath
      ? `https://mybusiness.googleapis.com/v4/${out.selected.reviewsPath}?pageSize=1`
      : null;
    const calls: [GbpCallFailure['call'], string, () => Promise<unknown>][] = [
      [
        'business_information',
        gbpInfoUrl(locationName),
        async () => {
          const meta = await googleRequest<LocationMeta>(gbpInfoUrl(locationName), {
            accessToken: token,
            retries: 0,
          });
          out.locationStatus = {
            title: meta.title ?? null,
            // hasVoiceOfMerchant = verified and the business owner controls the listing.
            verifiedOwnerControl: meta.metadata?.hasVoiceOfMerchant ?? null,
            duplicateOf: meta.metadata?.duplicateLocation ?? null,
            openStatus: meta.openInfo?.status ?? null,
            mapsUri: meta.metadata?.mapsUri ?? null,
          };
        },
      ],
      [
        'performance',
        gbpPerformanceUrl(locationName, period),
        () =>
          googleRequest(gbpPerformanceUrl(locationName, period), {
            accessToken: token,
            retries: 0,
          }),
      ],
      [
        'reviews',
        reviewsUrl ?? '(invalid account/location names)',
        () => {
          if (!reviewsUrl) throw new Error('Invalid account/location names for the reviews path');
          return googleRequest(reviewsUrl, { accessToken: token, retries: 0 });
        },
      ],
    ];
    for (const [call, endpoint, fn] of calls) {
      try {
        await fn();
        out.probes.push({
          call,
          label: GBP_CALL_LABEL[call],
          ok: true,
          endpoint: `GET ${endpoint}`,
        });
      } catch (e) {
        out.probes.push({
          call,
          label: GBP_CALL_LABEL[call],
          ok: false,
          endpoint: `GET ${endpoint}`,
          failure: toCallFailure(call, e),
        });
      }
    }

    // 3) Plain-language hints from what was found.
    const owning = out.accounts.find((a) => a.locations.some((l) => l.name === locationName));
    if (out.accounts.length && !owning) {
      hints.push(
        `The selected location ${locationName} was not found under any account this Google user can see. Pick the location again.`,
      );
    }
    if (owning && owning.name !== accountName) {
      hints.push(
        `The location is listed under ${owning.name}, but the app uses ${accountName}. Reviews must use accounts/{accountId}/locations/{locationId} of the account that holds the location: pick the location again.`,
      );
    }
    const st = out.locationStatus;
    if (st?.verifiedOwnerControl === false) {
      hints.push(
        `The selected location "${st.title ?? locationName}" is not verified (no owner control on Google). Google does not return performance data for unverified locations: verify it at business.google.com or select your verified location.`,
      );
    }
    if (st?.duplicateOf) {
      hints.push(
        `The selected location is marked by Google as a duplicate of ${st.duplicateOf}. Select the original location instead.`,
      );
    }
    const sameTitle = owning?.locations.filter((l) => st?.title && l.title === st.title) ?? [];
    if (sameTitle.length > 1) {
      hints.push(
        `There are ${sameTitle.length} locations named "${st?.title}" (${sameTitle.map((l) => l.name).join(', ')}). Make sure the verified one is selected.`,
      );
    }
    const myRole = owning?.locations.find((l) => l.name === locationName)?.yourRole;
    if (myRole && !['PRIMARY_OWNER', 'OWNER', 'MANAGER'].includes(myRole)) {
      hints.push(
        `Your role on this location is ${myRole}. Performance data and reviews need Owner or Manager: ask the owner to make ${connectedEmail} a Manager in Business Profile.`,
      );
    }
    for (const p of out.probes.filter((x) => !x.ok)) {
      const f = p.failure!;
      const text = `${f.reason} ${f.message} ${f.body ?? ''}`;
      if (/SERVICE_DISABLED|has not been used|is disabled/i.test(text)) {
        hints.push(
          `${p.label}: this API is not enabled in the Cloud project. Enable it in APIs & Services > Library.`,
        );
      } else if (f.status === 429) {
        hints.push(
          `${p.label}: quota exceeded or 0 (Business Profile API access may not be approved yet).`,
        );
      } else if (f.status === 403) {
        hints.push(
          p.call === 'reviews'
            ? 'Reviews (My Business API v4) returned 403: enable the "Google My Business API" in the Cloud project, make sure Business Profile API access is approved, and that the connected user is Owner/Manager of this location.'
            : `${p.label} returned 403: the connected user needs Owner/Manager access to this location, and the API must be enabled and approved for the Cloud project.`,
        );
      }
    }
  }
  if (hints.length === 0) hints.push('No problems found. Run a health check to sync again.');
  return out;
}
