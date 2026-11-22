// Places API (New) for local competitor research (Phase 2).
// Terms: only place IDs may be stored long-term. Ratings, review counts and names are fetched live
// and shown, never saved to our database. Field masks keep requests on the cheapest SKU needed.
import { googleRequest } from './http';

export type PlaceResult = {
  placeId: string;
  name: string;
  address: string | null;
  rating: number | null;
  userRatingCount: number | null;
  primaryType: string | null;
  mapsUri: string | null;
};

type RawPlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  primaryTypeDisplayName?: { text?: string };
  googleMapsUri?: string;
};

/** Minimum fields we display. rating/userRatingCount are what the comparison needs. */
export const SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.googleMapsUri';
export const DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,rating,userRatingCount,primaryTypeDisplayName,googleMapsUri';

export function toPlaceResult(p: RawPlace): PlaceResult {
  return {
    placeId: p.id,
    name: p.displayName?.text ?? p.id,
    address: p.formattedAddress ?? null,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    primaryType: p.primaryTypeDisplayName?.text ?? null,
    mapsUri: p.googleMapsUri ?? null,
  };
}

/** Text search, e.g. "dentist in Kothrud Pune". Max 10 results. */
export async function searchPlaces(apiKey: string, textQuery: string): Promise<PlaceResult[]> {
  const data = await googleRequest<{ places?: RawPlace[] }>(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      json: { textQuery, maxResultCount: 10, languageCode: 'en', regionCode: 'IN' },
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': SEARCH_FIELD_MASK },
      retries: 1,
    },
  );
  return (data.places ?? []).map(toPlaceResult);
}

export async function getPlace(apiKey: string, placeId: string): Promise<PlaceResult> {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new Error('Invalid place ID');
  const data = await googleRequest<RawPlace>(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAILS_FIELD_MASK },
    retries: 1,
  });
  return toPlaceResult(data);
}

/** Pure: rank the client among competitors by rating, then review count. */
export function compareWithCompetitors(
  rows: (PlaceResult & { isClient: boolean; label: string })[],
) {
  const ranked = [...rows].sort(
    (a, b) =>
      (b.rating ?? 0) - (a.rating ?? 0) || (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0),
  );
  const others = rows.filter((r) => !r.isClient && r.rating !== null);
  const avgRating = others.length
    ? Math.round((others.reduce((s, r) => s + (r.rating ?? 0), 0) / others.length) * 10) / 10
    : null;
  const avgReviews = others.length
    ? Math.round(others.reduce((s, r) => s + (r.userRatingCount ?? 0), 0) / others.length)
    : null;
  const clientRank = ranked.findIndex((r) => r.isClient);
  return {
    ranked,
    competitorAvgRating: avgRating,
    competitorAvgReviews: avgReviews,
    clientRank: clientRank === -1 ? null : clientRank + 1,
  };
}

/**
 * Rating, review count and up to 5 review texts of a place, for the AI competitor analysis.
 * Fetched live and never stored (Places terms). The `reviews` field is billed on a higher SKU.
 */
export async function getPlaceReviews(
  apiKey: string,
  placeId: string,
): Promise<{
  name: string;
  rating: number | null;
  userRatingCount: number | null;
  reviews: { rating: number | null; text: string }[];
}> {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new Error('Invalid place ID');
  const data = await googleRequest<{
    displayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    reviews?: { rating?: number; text?: { text?: string }; originalText?: { text?: string } }[];
  }>(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,reviews',
    },
    retries: 1,
  });
  return {
    name: data.displayName?.text ?? placeId,
    rating: data.rating ?? null,
    userRatingCount: data.userRatingCount ?? null,
    reviews: (data.reviews ?? [])
      .map((r) => ({ rating: r.rating ?? null, text: r.text?.text ?? r.originalText?.text ?? '' }))
      .filter((r) => r.text.trim().length > 0),
  };
}
