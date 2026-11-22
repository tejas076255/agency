// Business Profile Score (0-100): a pure, unit-tested checklist. Each item says what is missing,
// why it matters, how many points it is worth and who can fix it (AI, app, the owner or Google).

export type ProfileFacts = {
  verified: boolean | null;
  title: string | null;
  primaryCategory: string | null;
  additionalCategories: number;
  websiteUri: string | null;
  websiteMatchesClient: boolean | null;
  phone: string | null;
  phoneMatchesWebsite: boolean | null;
  hasAddress: boolean;
  hoursSet: boolean;
  descriptionLength: number;
  descriptionMentionsCity: boolean;
  services: number;
  attributesSet: number;
  lastPostAt: number | null; // epoch ms, 0 = never, null = unknown
  photoCount: number | null;
  reviewCount: number | null;
  averageRating: number | null;
  replyRate: number | null; // 0..1 over the last 50 reviews
  recentReviews30: number;
  competitorAvgReviews: number | null;
  mapOnWebsite: boolean | null;
  brandPosition: number | null; // Google position for the business name
  now: number;
};

export type FixType = 'ai' | 'app' | 'you' | 'google';
export type ItemStatus = 'ok' | 'improve' | 'missing';
export type ScoreGroup = 'basics' | 'content' | 'trust' | 'consistency';

export type ScoreItem = {
  id: string;
  group: ScoreGroup;
  title: string;
  status: ItemStatus;
  points: number;
  max: number;
  why: string;
  detail: string;
  /** Who fixes it: AI draft (one-click post), the app (prefilled), the owner, or only Google. */
  fix: FixType;
};

export const GROUP_LABEL: Record<ScoreGroup, string> = {
  basics: 'Basics',
  content: 'Content',
  trust: 'Reviews & trust',
  consistency: 'Consistency',
};

const DAY = 86_400_000;

export function computeProfileScore(f: ProfileFacts): { score: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [];
  const add = (
    id: string,
    group: ScoreGroup,
    title: string,
    max: number,
    points: number,
    why: string,
    detail: string,
    fix: FixType,
  ) => {
    const p = Math.max(0, Math.min(max, Math.round(points * 10) / 10));
    items.push({
      id,
      group,
      title,
      max,
      points: p,
      status: p >= max ? 'ok' : p === 0 ? 'missing' : 'improve',
      why,
      detail,
      fix,
    });
  };

  // ---------------- Basics (30) ----------------
  add(
    'verified',
    'basics',
    'Listing is verified',
    8,
    f.verified ? 8 : 0,
    'Unverified listings rank lower and Google may ignore your edits.',
    f.verified ? 'Verified with owner control' : f.verified === false ? 'Not verified' : 'Unknown',
    'google',
  );
  add(
    'category',
    'basics',
    'Primary category',
    4,
    f.primaryCategory ? 4 : 0,
    'The main category decides which searches you appear in.',
    f.primaryCategory ?? 'Missing',
    'you',
  );
  add(
    'website',
    'basics',
    'Website link',
    4,
    f.websiteUri ? (f.websiteMatchesClient === false ? 2 : 4) : 0,
    'Customers and Google use it to learn more and to trust the listing.',
    f.websiteUri
      ? f.websiteMatchesClient === false
        ? `Points to ${f.websiteUri}, not the client website`
        : f.websiteUri
      : 'Missing',
    'app',
  );
  add(
    'phone',
    'basics',
    'Phone number',
    3,
    f.phone ? 3 : 0,
    'Lets customers call from Google Search and Maps.',
    f.phone ?? 'Missing',
    'you',
  );
  add(
    'hours',
    'basics',
    'Opening hours',
    5,
    f.hoursSet ? 5 : 0,
    'Without hours Google may show "Hours unknown" and people go to competitors.',
    f.hoursSet ? 'Set' : 'Missing',
    'app',
  );
  add(
    'address',
    'basics',
    'Address',
    2,
    f.hasAddress ? 2 : 0,
    'Needed to show on Maps and for "near me" searches.',
    f.hasAddress ? 'Set' : 'Missing',
    'you',
  );
  add(
    'description_present',
    'basics',
    'Business description',
    4,
    f.descriptionLength > 0 ? 4 : 0,
    'Tells customers what you do in your own words.',
    f.descriptionLength ? `${f.descriptionLength} characters` : 'Missing',
    'ai',
  );

  // ---------------- Content (25) ----------------
  const descQuality =
    (f.descriptionLength >= 600 ? 4 : f.descriptionLength >= 300 ? 2 : 0) +
    (f.descriptionMentionsCity ? 2 : 0);
  add(
    'description_quality',
    'content',
    'Description is detailed (600+ characters, mentions your city)',
    6,
    descQuality,
    'A complete description with services and area helps you match more searches.',
    `${f.descriptionLength}/750 characters${f.descriptionMentionsCity ? ', mentions the city' : ', city not mentioned'}`,
    'ai',
  );
  add(
    'services',
    'content',
    'Services listed',
    6,
    Math.min(6, (f.services / 5) * 6),
    'Services appear on the listing and help Google show you for those searches.',
    `${f.services} listed (5+ recommended)`,
    'ai',
  );
  add(
    'extra_categories',
    'content',
    'Extra categories',
    3,
    Math.min(3, f.additionalCategories * 1.5),
    'Extra categories make you eligible for more searches.',
    `${f.additionalCategories} added`,
    'ai',
  );
  add(
    'attributes',
    'content',
    'Attributes (accessibility, amenities…)',
    3,
    Math.min(3, f.attributesSet),
    'Attributes answer common customer questions on the listing.',
    `${f.attributesSet} set`,
    'ai',
  );
  const postAge = f.lastPostAt ? (f.now - f.lastPostAt) / DAY : null;
  add(
    'posts',
    'content',
    'Posted on Google in the last 7 days',
    4,
    f.lastPostAt === null
      ? 0
      : postAge !== null && postAge <= 7
        ? 4
        : postAge !== null && postAge <= 30
          ? 2
          : 0,
    'Regular posts show the business is active and can bring more clicks.',
    f.lastPostAt === null
      ? 'Could not check'
      : f.lastPostAt === 0
        ? 'No posts yet'
        : `Last post ${Math.round(postAge!)} day(s) ago`,
    'ai',
  );
  add(
    'photos',
    'content',
    'At least 10 photos',
    3,
    f.photoCount === null ? 0 : Math.min(3, (f.photoCount / 10) * 3),
    'Listings with photos get more direction requests and website clicks.',
    f.photoCount === null ? 'Could not check' : `${f.photoCount} photo(s)`,
    'you',
  );

  // ---------------- Reviews & trust (30) ----------------
  const count = f.reviewCount ?? 0;
  const target = Math.max(20, f.competitorAvgReviews ?? 20);
  add(
    'review_count',
    'trust',
    'Number of reviews',
    10,
    Math.min(10, (count / target) * 10),
    'More reviews than competitors is one of the strongest local ranking signals.',
    `${count} review(s)${f.competitorAvgReviews !== null ? ` · competitors average ${Math.round(f.competitorAvgReviews)}` : ''}`,
    'you',
  );
  add(
    'rating',
    'trust',
    'Average rating 4.5+',
    8,
    f.averageRating === null
      ? 0
      : f.averageRating >= 4.5
        ? 8
        : f.averageRating >= 4
          ? 5
          : f.averageRating >= 3.5
            ? 2
            : 0,
    'Most people only choose businesses rated 4 stars or more.',
    f.averageRating === null ? 'No rating yet' : `${f.averageRating.toFixed(1)} ★`,
    'you',
  );
  add(
    'replies',
    'trust',
    'Replies to reviews',
    8,
    f.replyRate === null ? (count === 0 ? 0 : 0) : f.replyRate * 8,
    'Replying shows you care; Google recommends replying to every review.',
    f.replyRate === null ? 'No reviews to reply to' : `${Math.round(f.replyRate * 100)}% replied`,
    'ai',
  );
  add(
    'recent_reviews',
    'trust',
    'New review in the last 30 days',
    4,
    f.recentReviews30 >= 3 ? 4 : f.recentReviews30 >= 1 ? 2 : 0,
    'Fresh reviews tell customers the business is active today.',
    `${f.recentReviews30} in the last 30 days`,
    'you',
  );

  // ---------------- Consistency (15) ----------------
  add(
    'nap',
    'consistency',
    'Name, phone and website match the website',
    9,
    (f.phoneMatchesWebsite === false ? 0 : 5) +
      (f.websiteMatchesClient === false || !f.websiteUri ? 0 : 4),
    'Google trusts listings whose details match the website everywhere.',
    [
      f.phoneMatchesWebsite === false
        ? 'Phone differs from the website'
        : f.phoneMatchesWebsite
          ? 'Phone matches'
          : 'Phone not checked',
      !f.websiteUri
        ? 'no website on listing'
        : f.websiteMatchesClient === false
          ? 'website differs'
          : 'website matches',
    ].join(' · '),
    'you',
  );
  add(
    'map_on_site',
    'consistency',
    'Google Map on the website',
    3,
    f.mapOnWebsite ? 3 : 0,
    'A map embed links your website to the listing.',
    f.mapOnWebsite === null ? 'Could not check' : f.mapOnWebsite ? 'Found' : 'Not found',
    'you',
  );
  add(
    'brand_rank',
    'consistency',
    '#1 on Google for your business name',
    3,
    f.brandPosition === null ? 0 : f.brandPosition <= 1.5 ? 3 : f.brandPosition <= 3 ? 2 : 1,
    'People searching your name should find you first.',
    f.brandPosition === null ? 'No data yet' : `Position ${f.brandPosition.toFixed(1)}`,
    'you',
  );

  const score = Math.round(items.reduce((s, i) => s + i.points, 0));
  return { score: Math.min(100, score), items };
}

/** Pure: score if every item that has a ready fix gets its full points. */
export function projectedScore(score: number, items: ScoreItem[], fixedIds: Set<string>): number {
  const gain = items.filter((i) => fixedIds.has(i.id)).reduce((s, i) => s + (i.max - i.points), 0);
  return Math.min(100, Math.round(score + gain));
}
