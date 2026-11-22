// Shapes returned by the Worker API (kept in sync with src/routes/*).

export type ClientStatus = 'active' | 'not_connected' | 'reconnect_needed';

export type ClientListItem = {
  id: string;
  name: string;
  websiteUrl: string;
  status: ClientStatus;
  score: number | null;
  previousScore: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  sourcesSelected: boolean;
  /** Grow: latest Business Profile score and one-click fixes waiting. */
  profileScore: number | null;
  fixesReady: number;
};

export type FieldData = {
  source: 'url' | 'origin';
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  cwvPassed: boolean | null;
};

export type SpeedResult = {
  strategy: 'mobile' | 'desktop';
  score: number;
  /** Present on checks saved after the lab/field split. */
  lab?: { lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null };
  field?: FieldData | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  tbtMs: number | null;
  opportunities: { title: string; savingsMs: number }[];
};

export type GscSummary = {
  siteUrl: string;
  totals: { current: { clicks: number; impressions: number; ctr: number; position: number } };
  clicksChangePct: number | null;
  impressionsChangePct: number | null;
  topQueries: {
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
  topPages?: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  quickWins: { query: string; impressions: number; clicks: number; position: number }[];
  droppingPages: { page: string; clicksNow: number; clicksBefore: number; change: number }[];
  dailyClicks: { date: string; clicks: number }[];
};

export type Ga4Summary = {
  totals: {
    current: {
      sessions: number;
      users: number;
      keyEvents: number;
      engagementRate: number;
      newUsers?: number;
    };
  };
  sessionsChangePct: number | null;
  usersChangePct: number | null;
  newUsersChangePct?: number | null;
  keyEventsChangePct: number | null;
  organicSessions?: { current: number; previous: number; changePct: number | null } | null;
  topChannels: { channel: string; sessions: number }[];
  topLandingPages: { page: string; sessions: number; keyEvents: number }[];
  dailySessions: { date: string; sessions: number }[];
};

export type Section = { points: number; max: number } | null;

/** v2 keys (search/traffic/performance/completeness) or v1 keys (seo/traffic/speed). */
export type ScoreBreakdown = Partial<
  Record<'search' | 'traffic' | 'performance' | 'completeness' | 'seo' | 'speed', Section>
>;

export type ActionItem = {
  id: string;
  priority: number;
  title: string;
  description: string | null;
  why: string;
  expectedImpact: string;
  supportingMetrics: string[];
  done: boolean;
};

export type ReportStatus = 'generating' | 'ready' | 'sent' | 'failed';

export type ClientDetail = {
  client: {
    id: string;
    name: string;
    websiteUrl: string;
    contactEmail: string;
    gscSiteUrl: string | null;
    ga4PropertyId: string | null;
    status: ClientStatus;
    autoSendReport: boolean;
    assignedUserId?: string | null;
  };
  connection: {
    googleEmail: string;
    status: 'active' | 'revoked';
    connectedAt: number;
    canReadGsc: boolean;
    canReadGa4: boolean;
  } | null;
  latestCheck: {
    id: string;
    runAt: number;
    score: number | null;
    formulaVersion: number;
    status: 'ok' | 'partial' | 'failed';
    errors: Record<string, string>;
    breakdown: ScoreBreakdown | null;
    gsc: GscSummary | null;
    ga4: Ga4Summary | null;
    pagespeed: { mobile: SpeedResult | null; desktop: SpeedResult | null } | null;
  } | null;
  history: {
    runAt: number;
    score: number | null;
    mobileSpeed: number | null;
    desktopSpeed: number | null;
  }[];
  insight: {
    id: string;
    summary: string;
    summaryHinglish: string | null;
    modelUsed: string;
    createdAt: number;
    actionItems: ActionItem[];
  } | null;
  reports: {
    id: string;
    month: string;
    status: ReportStatus;
    error: string | null;
    shareUrl: string;
    sentAt: number | null;
    createdAt: number;
    slidesFileId: string | null;
  }[];
  pending: { healthCheck: boolean; report: boolean };
};

export type ReportListItem = {
  id: string;
  clientId: string;
  clientName: string;
  month: string;
  status: ReportStatus;
  error: string | null;
  shareUrl: string;
  slidesFileId: string | null;
  sentAt: number | null;
  createdAt: number;
};

export type GoogleOptions = {
  sites: { siteUrl: string; permissionLevel: string }[];
  properties: { id: string; name: string; account: string }[];
  errors: { sites: string | null; properties: string | null };
};

export type JobRun = {
  id: string;
  type: 'health_check' | 'monthly_report';
  trigger: 'cron' | 'manual';
  status: string;
  error: string | null;
  attempt: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  clientId: string;
  clientName: string;
};

export type UsageRow = {
  api: string;
  day: string;
  calls: number;
  errors: number;
  quotaErrors: number;
};

export type AuditLogRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  userName: string | null;
  userEmail: string | null;
};

export type ReportSettings = {
  emailSubject: string;
  emailMessage: string;
  ccAgency: boolean;
  includeHinglish: boolean;
};

// ------------------------------ Phase 2 / 3 / 4 ------------------------------

export type Snapshot<T> = {
  runAt: number;
  status: 'ok' | 'failed';
  error: string | null;
  /** Present only for successful syncs. */
  data: T | null;
  /** Failed syncs: the exact Google calls that failed. */
  details?:
    | {
        call?: string;
        endpoint?: string;
        status?: number | null;
        reason?: string;
        message?: string;
      }[]
    | null;
} | null;

export type ProductState<T> = {
  connection: { googleEmail: string; status: 'active' | 'revoked'; connectedAt: number } | null;
  selected: string | null;
  latest: Snapshot<T>;
};

type MetricTotals = {
  impressions: number;
  calls: number;
  directions: number;
  websiteClicks: number;
  conversations: number;
};
export type GbpData = {
  location: {
    title: string;
    address: string;
    phone: string | null;
    website: string | null;
    primaryCategory: string | null;
    additionalCategories: string[];
    openStatus: string | null;
    mapsUri: string | null;
    hoursSet: boolean;
  };
  totals: { current: MetricTotals; previous: MetricTotals };
  changePct: Record<keyof MetricTotals, number | null>;
  daily: {
    date: string;
    impressions: number;
    calls: number;
    directions: number;
    websiteClicks: number;
  }[];
  reviews: { averageRating: number | null; totalReviewCount: number | null };
};

type AdsTotals = {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionValue: number;
};
export type AdsData = {
  currency: string;
  totals: { current: AdsTotals; previous: AdsTotals };
  derived: {
    ctrPct: number | null;
    avgCpc: number | null;
    costPerConversion: number | null;
    roas: number | null;
  };
  changePct: { cost: number | null; clicks: number | null; conversions: number | null };
  campaigns: {
    id: string;
    name: string;
    status: string;
    cost: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionValue: number;
    dailyBudget: number | null;
    budgetUtilizationPct: number | null;
  }[];
  wastedSearchTerms: { term: string; campaign: string; cost: number; clicks: number }[];
  wastedSpend: number;
  daily: { date: string; cost: number; clicks: number; conversions: number }[];
};

type YtTotals = {
  views: number;
  watchMinutes: number;
  avgViewDurationSec: number;
  subscribersGained: number;
  subscribersLost: number;
};
export type YouTubeData = {
  channel: {
    id: string;
    title: string;
    subscribers: number | null;
    totalViews: number | null;
    videos: number | null;
  };
  totals: { current: YtTotals; previous: YtTotals };
  changePct: { views: number | null; watchMinutes: number | null; netSubscribers: number | null };
  daily: { date: string; views: number; watchMinutes: number; netSubscribers: number }[];
  topVideos: {
    id: string;
    title: string;
    views: number;
    watchMinutes: number;
    avgViewDurationSec: number;
  }[];
};

export type ReviewRow = {
  id: string;
  reviewerName: string | null;
  starRating: number | null;
  comment: string | null;
  reviewCreatedAt: number | null;
  replyComment: string | null;
  autoReplied?: boolean;
  label: 'positive' | 'neutral' | 'negative' | null;
  sentimentScore: number | null;
  entities: string[];
};

export type Integrations = {
  config: {
    places: boolean;
    naturalLanguage: boolean;
    workspaceConnected: boolean;
  };
  gbp: ProductState<GbpData>;
  ads: ProductState<AdsData>;
  youtube: ProductState<YouTubeData>;
  autoReply: { minStars: 4 | 5 | null; language: 'en' | 'hinglish' | 'hi' };
  reviews: {
    stats: {
      recent30: number;
      negative30: number;
      unanswered: number;
      averageRating: number | null;
    } | null;
    sentimentCounts: { positive: number; neutral: number; negative: number };
    themes: {
      positive: { name: string; count: number }[];
      negative: { name: string; count: number }[];
    };
    trend: { month: string; count: number; avgRating: number }[];
    recent: ReviewRow[];
  };
  competitors: { id: string; placeId: string; label: string; isClient: boolean }[];
  exports: {
    id: string;
    url: string | null;
    status: 'ok' | 'failed';
    error: string | null;
    createdAt: number;
  }[];
};

export type PlaceResult = {
  placeId: string;
  name: string;
  address: string | null;
  rating: number | null;
  userRatingCount: number | null;
  primaryType: string | null;
  mapsUri: string | null;
};

export type ChannelOverviewRow = {
  id: string;
  name: string;
  gbpSelected: boolean;
  adsSelected: boolean;
  youtubeSelected: boolean;
  gbp: {
    runAt: number;
    error: string | null;
    calls: number | null;
    callsChangePct: number | null;
    directions: number | null;
    impressions: number | null;
    rating: number | null;
    reviewCount: number | null;
  } | null;
  reviews: {
    recent30: number;
    negative30: number;
    unanswered: number;
    averageRating: number | null;
  } | null;
  ads: {
    runAt: number;
    error: string | null;
    currency: string | null;
    cost: number | null;
    conversions: number | null;
    roas: number | null;
    wastedSpend: number | null;
  } | null;
  youtube: {
    runAt: number;
    error: string | null;
    views: number | null;
    viewsChangePct: number | null;
    netSubscribers: number | null;
  } | null;
};

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'member';
  pictureUrl: string | null;
  assignedClients: number;
};

export type Billing = {
  plan: 'free' | 'pro' | 'agency';
  limits: {
    name: string;
    monthlyPriceInr: number;
    maxClients: number;
    maxMembers: number;
    manualRunsPerDay: number;
    maxKeywordsPerClient: number;
    aiRequestsPerDay: number;
  };
  usage: { clients: number; members: number; pendingInvites: number; manualRunsToday: number };
  plans: Record<
    string,
    {
      name: string;
      monthlyPriceInr: number;
      maxClients: number;
      maxMembers: number;
      manualRunsPerDay: number;
      maxKeywordsPerClient: number;
      aiRequestsPerDay: number;
    }
  >;
  paymentsEnabled: boolean;
};

// ------------------------------- Keyword rank tracker -------------------------------

export type KeywordWeek = {
  periodEnd: string;
  position: number | null;
  clicks: number;
  impressions: number;
};

export type TrackedKeyword = {
  id: string;
  keyword: string;
  createdAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  latest: (KeywordWeek & { topPage: string | null }) | null;
  change: number | null;
  changeAll: number | null;
  best: number | null;
  history: KeywordWeek[];
};

export type KeywordsResponse = {
  keywords: TrackedKeyword[];
  suggestions: { keyword: string; position: number; impressions: number }[];
  notReady: string | null;
  limit: number;
};

// ------------------------------- AI features -------------------------------

export type AiLanguage = 'en' | 'hinglish' | 'hi';

export type AlertRow = {
  id: string;
  clientId: string;
  clientName?: string;
  kind: string;
  severity: 'high' | 'medium';
  title: string;
  explanation: string | null;
  explanationSource: 'ai' | 'fallback' | null;
  emailed: boolean;
  read: boolean;
  createdAt: number;
};

export type SiteChecks = {
  url: string;
  finalUrl: string | null;
  fetchError: string | null;
  https: boolean;
  statusCode: number | null;
  responseMs: number | null;
  htmlKb: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  canonical: string | null;
  viewport: boolean;
  lang: string | null;
  openGraph: boolean;
  schemaTypes: string[];
  images: number;
  imagesMissingAlt: number;
  wordCount: number;
  internalLinks: number;
  robotsTxt: boolean | null;
  sitemap: boolean | null;
  mobileScore: number | null;
  desktopScore: number | null;
  mobileLcpMs: number | null;
  cwvPassed: boolean | null;
  speedFixes: string[];
  score?: number;
};

export type AuditReport = {
  summary: string;
  issues: { title: string; severity: 'high' | 'medium' | 'low'; detail: string; fix: string }[];
  opportunities: string[];
  pitch: string;
};

export type ProspectAudit = {
  id: string;
  url: string;
  businessName: string | null;
  status: 'ready' | 'failed';
  checks: SiteChecks | null;
  report: AuditReport | null;
  reportSource: 'ai' | 'fallback' | null;
  error: string | null;
  createdAt: number;
  score?: number | null;
};
