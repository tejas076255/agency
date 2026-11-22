// Google Business Profile WRITE access: profile fields (Business Information API v1 PATCH with
// updateMask + validateOnly), attributes, category lookup, and Google Posts (My Business API v4
// localPosts). Name, address and phone are deliberately NOT editable from here.
import { googleRequest, GoogleApiError } from './http';

const BI = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const V4 = 'https://mybusiness.googleapis.com/v4';

export const DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export type Day = (typeof DAYS)[number];

type TimeOfDay = { hours?: number; minutes?: number };
type Category = { name: string; displayName?: string };
type ServiceItem = {
  price?: unknown;
  freeFormServiceItem?: {
    category: string;
    label: { displayName: string; description?: string; languageCode?: string };
  };
  structuredServiceItem?: { serviceTypeId: string; description?: string };
};

export type RawEditableLocation = {
  name: string;
  title?: string;
  profile?: { description?: string };
  categories?: { primaryCategory?: Category; additionalCategories?: Category[] };
  serviceItems?: ServiceItem[];
  regularHours?: {
    periods?: { openDay: Day; openTime?: TimeOfDay; closeDay: Day; closeTime?: TimeOfDay }[];
  };
  metadata?: { hasVoiceOfMerchant?: boolean; hasPendingEdits?: boolean; mapsUri?: string };
};

/** What the app edits, in a simple shape (also stored as before/after on each change). */
export type EditableProfile = {
  description: string;
  primaryCategory: { name: string; displayName: string } | null;
  additionalCategories: { name: string; displayName: string }[];
  services: { label: string; description: string; category: string; structured?: boolean }[];
  hours: { day: Day; open: string; close: string }[];
  attributes: { name: string; value: boolean }[];
  verified: boolean | null;
  hasPendingEdits: boolean;
};

const READ_MASK = 'name,title,profile,categories,serviceItems,regularHours,metadata';

const hhmm = (t?: TimeOfDay) =>
  `${String(t?.hours ?? 0).padStart(2, '0')}:${String(t?.minutes ?? 0).padStart(2, '0')}`;
const toTime = (s: string): TimeOfDay => {
  const [h, m] = s.split(':').map(Number) as [number, number];
  return m ? { hours: h, minutes: m } : { hours: h };
};

/** Pure (unit-tested): Google's location JSON -> EditableProfile. */
export function toEditableProfile(
  raw: RawEditableLocation,
  attributes: { name: string; value: boolean }[] = [],
): EditableProfile {
  const cat = (c?: Category) => (c ? { name: c.name, displayName: c.displayName ?? c.name } : null);
  return {
    description: raw.profile?.description ?? '',
    primaryCategory: cat(raw.categories?.primaryCategory),
    additionalCategories: (raw.categories?.additionalCategories ?? []).map((c) => cat(c)!),
    services: (raw.serviceItems ?? []).map((s) =>
      s.freeFormServiceItem
        ? {
            label: s.freeFormServiceItem.label.displayName,
            description: s.freeFormServiceItem.label.description ?? '',
            category: s.freeFormServiceItem.category,
          }
        : {
            label: s.structuredServiceItem?.serviceTypeId ?? '',
            description: s.structuredServiceItem?.description ?? '',
            category: '',
            structured: true,
          },
    ),
    hours: (raw.regularHours?.periods ?? []).map((p) => ({
      day: p.openDay,
      open: hhmm(p.openTime),
      close: p.closeTime?.hours === 24 ? '24:00' : hhmm(p.closeTime),
    })),
    attributes,
    verified: raw.metadata?.hasVoiceOfMerchant ?? null,
    hasPendingEdits: raw.metadata?.hasPendingEdits ?? false,
  };
}

export type ChangeKind = 'description' | 'categories' | 'services' | 'hours' | 'attributes';

/**
 * Pure (unit-tested): request body + updateMask for one kind of change. Services are a full
 * replacement, so structured (Google-defined) services from `current` are kept untouched.
 */
export function buildPatch(
  kind: Exclude<ChangeKind, 'attributes'>,
  after: EditableProfile,
  current: RawEditableLocation,
): { body: Record<string, unknown>; updateMask: string } {
  if (kind === 'description') {
    return {
      body: { profile: { description: after.description } },
      updateMask: 'profile.description',
    };
  }
  if (kind === 'categories') {
    const primary = current.categories?.primaryCategory;
    if (!primary) throw new Error('The listing has no primary category; set it on Google first');
    return {
      body: {
        categories: {
          primaryCategory: { name: primary.name },
          additionalCategories: after.additionalCategories.map((c) => ({ name: c.name })),
        },
      },
      updateMask: 'categories',
    };
  }
  if (kind === 'services') {
    const structured = (current.serviceItems ?? []).filter((s) => s.structuredServiceItem);
    const freeForm = after.services
      .filter((s) => !s.structured)
      .map((s) => ({
        freeFormServiceItem: {
          category: s.category,
          label: {
            displayName: s.label,
            ...(s.description ? { description: s.description } : {}),
            languageCode: 'en',
          },
        },
      }));
    return { body: { serviceItems: [...structured, ...freeForm] }, updateMask: 'serviceItems' };
  }
  return {
    body: {
      regularHours: {
        periods: after.hours.map((h) => ({
          openDay: h.day,
          openTime: toTime(h.open),
          closeDay: h.day,
          closeTime: toTime(h.close),
        })),
      },
    },
    updateMask: 'regularHours',
  };
}

export async function getEditableLocation(
  token: string,
  locationName: string,
): Promise<RawEditableLocation> {
  return googleRequest<RawEditableLocation>(`${BI}/${locationName}?readMask=${READ_MASK}`, {
    accessToken: token,
    retries: 1,
  });
}

type RawAttribute = { name: string; valueType?: string; values?: unknown[] };

export async function getAttributes(
  token: string,
  locationName: string,
): Promise<{ name: string; value: boolean }[]> {
  const r = await googleRequest<{ attributes?: RawAttribute[] }>(
    `${BI}/${locationName}/attributes`,
    { accessToken: token, retries: 1 },
  );
  return (r.attributes ?? [])
    .filter((a) => a.valueType === 'BOOL' || typeof a.values?.[0] === 'boolean')
    .map((a) => ({
      name: a.name.replace(/^locations\/[^/]+\//, ''),
      value: a.values?.[0] === true,
    }));
}

export type AttributeMeta = { name: string; displayName: string; group: string };

/** Yes/no attributes Google offers for this listing's category (e.g. wheelchair access). */
export async function listAvailableAttributes(
  token: string,
  locationName: string,
): Promise<AttributeMeta[]> {
  const r = await googleRequest<{
    attributeMetadata?: {
      parent: string;
      valueType?: string;
      displayName?: string;
      groupDisplayName?: string;
      deprecated?: boolean;
    }[];
  }>(`${BI}/attributes?parent=${locationName}&languageCode=en&regionCode=IN&pageSize=200`, {
    accessToken: token,
    retries: 1,
  });
  return (r.attributeMetadata ?? [])
    .filter((a) => a.valueType === 'BOOL' && !a.deprecated)
    .map((a) => ({
      name: a.parent,
      displayName: a.displayName ?? a.parent,
      group: a.groupDisplayName ?? 'Other',
    }));
}

/** Google's category list search, used to turn AI category ideas into real category IDs. */
export async function searchCategories(
  token: string,
  query: string,
): Promise<{ name: string; displayName: string }[]> {
  const u = new URL(`${BI}/categories`);
  u.searchParams.set('regionCode', 'IN');
  u.searchParams.set('languageCode', 'en');
  u.searchParams.set('view', 'BASIC');
  u.searchParams.set('pageSize', '5');
  u.searchParams.set('filter', `displayName=${query.replace(/[^\p{L}\p{N} &'-]/gu, ' ').trim()}`);
  const r = await googleRequest<{ categories?: { name: string; displayName?: string }[] }>(
    u.toString(),
    { accessToken: token, retries: 1 },
  );
  return (r.categories ?? []).map((c) => ({ name: c.name, displayName: c.displayName ?? c.name }));
}

/** PATCH profile fields. validateOnly = Google checks the change without saving it. */
export async function patchLocation(
  token: string,
  locationName: string,
  patch: { body: Record<string, unknown>; updateMask: string },
  validateOnly: boolean,
): Promise<RawEditableLocation> {
  const u = new URL(`${BI}/${locationName}`);
  u.searchParams.set('updateMask', patch.updateMask);
  if (validateOnly) u.searchParams.set('validateOnly', 'true');
  return googleRequest<RawEditableLocation>(u.toString(), {
    method: 'PATCH',
    accessToken: token,
    json: patch.body,
    retries: 0, // never repeat a write automatically
  });
}

export async function patchAttributes(
  token: string,
  locationName: string,
  values: { name: string; value: boolean }[],
): Promise<void> {
  if (values.length === 0) return;
  const u = new URL(`${BI}/${locationName}/attributes`);
  u.searchParams.set('attributeMask', values.map((v) => v.name).join(','));
  await googleRequest(u.toString(), {
    method: 'PATCH',
    accessToken: token,
    json: {
      name: `${locationName}/attributes`,
      attributes: values.map((v) => ({ name: v.name, values: [v.value] })),
    },
    retries: 0,
  });
}

// ------------------------------------ Google Posts ------------------------------------

export const POST_ACTIONS = ['LEARN_MORE', 'CALL', 'BOOK', 'ORDER', 'SHOP', 'SIGN_UP'] as const;
export type PostAction = (typeof POST_ACTIONS)[number];

/** Pure: v4 localPost body. CALL uses the listing's phone, so it has no URL. */
export function buildLocalPost(input: {
  summary: string;
  action: PostAction | null;
  url: string | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    languageCode: 'en',
    summary: input.summary,
    topicType: 'STANDARD',
  };
  if (input.action === 'CALL') body.callToAction = { actionType: 'CALL' };
  else if (input.action && input.url)
    body.callToAction = { actionType: input.action, url: input.url };
  return body;
}

export async function createLocalPost(
  token: string,
  accountName: string,
  locationName: string,
  body: Record<string, unknown>,
): Promise<{ name: string; searchUrl: string | null; state: string | null }> {
  const r = await googleRequest<{ name: string; searchUrl?: string; state?: string }>(
    `${V4}/${accountName}/${locationName}/localPosts`,
    { method: 'POST', accessToken: token, json: body, retries: 0 },
  );
  return { name: r.name, searchUrl: r.searchUrl ?? null, state: r.state ?? null };
}

export async function deleteLocalPost(token: string, postName: string): Promise<void> {
  try {
    await googleRequest(`${V4}/${postName}`, { method: 'DELETE', accessToken: token, retries: 0 });
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return; // already gone
    throw err;
  }
}
