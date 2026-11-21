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

export type SpeedResult = {
  strategy: 'mobile' | 'desktop';
  score: number;
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
  quickWins: { query: string; impressions: number; clicks: number; position: number }[];
  droppingPages: { page: string; clicksNow: number; clicksBefore: number; change: number }[];
  dailyClicks: { date: string; clicks: number }[];
};

export type Ga4Summary = {
  totals: {
    current: { sessions: number; users: number; keyEvents: number; engagementRate: number };
  };
  sessionsChangePct: number | null;
  usersChangePct: number | null;
  keyEventsChangePct: number | null;
  topChannels: { channel: string; sessions: number }[];
  topLandingPages: { page: string; sessions: number; keyEvents: number }[];
  dailySessions: { date: string; sessions: number }[];
};

export type Section = { points: number; max: number } | null;

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
    status: 'ok' | 'partial' | 'failed';
    errors: Record<string, string>;
    breakdown: { seo: Section; traffic: Section; speed: Section } | null;
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
    actionItems: {
      id: string;
      priority: number;
      title: string;
      why: string;
      expectedImpact: string;
      done: boolean;
    }[];
  } | null;
  reports: {
    id: string;
    month: string;
    status: 'generating' | 'ready' | 'sent' | 'failed';
    error: string | null;
    shareUrl: string;
    sentAt: number | null;
    createdAt: number;
    slidesFileId: string | null;
  }[];
  pending: { healthCheck: boolean; report: boolean };
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
