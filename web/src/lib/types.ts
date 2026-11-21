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
