// YouTube Data API v3 + YouTube Analytics API (Phase 3). OAuth by the channel owner:
// youtube.readonly (channel/video metadata) and yt-analytics.readonly (private analytics).
import { comparePeriods, pctChange, round, type DateRange } from '../lib/dates';
import { googleRequest } from './http';

export type ChannelOption = {
  id: string;
  title: string;
  subscribers: number | null;
  videos: number | null;
};

type RawChannel = {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
  statistics?: {
    subscriberCount?: string;
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
  };
};

export async function listMyChannels(token: string): Promise<ChannelOption[]> {
  const data = await googleRequest<{ items?: RawChannel[] }>(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true&maxResults=50',
    { accessToken: token },
  );
  return (data.items ?? []).map((c) => ({
    id: c.id,
    title: c.snippet?.title ?? c.id,
    subscribers: c.statistics?.hiddenSubscriberCount
      ? null
      : Number(c.statistics?.subscriberCount ?? 0),
    videos: Number(c.statistics?.videoCount ?? 0),
  }));
}

type Report = { columnHeaders?: { name: string }[]; rows?: (string | number)[][] };

/** Pure: turn a YouTube Analytics report into objects keyed by column name. */
export function reportRows(r: Report): Record<string, string | number>[] {
  const cols = (r.columnHeaders ?? []).map((c) => c.name);
  return (r.rows ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i] ?? 0])));
}

const METRICS =
  'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost';
type Totals = {
  views: number;
  watchMinutes: number;
  avgViewDurationSec: number;
  subscribersGained: number;
  subscribersLost: number;
};

const totalsOf = (row: Record<string, string | number> | undefined): Totals => ({
  views: Number(row?.views ?? 0),
  watchMinutes: Number(row?.estimatedMinutesWatched ?? 0),
  avgViewDurationSec: Number(row?.averageViewDuration ?? 0),
  subscribersGained: Number(row?.subscribersGained ?? 0),
  subscribersLost: Number(row?.subscribersLost ?? 0),
});

export type YouTubeSummary = {
  channel: {
    id: string;
    title: string;
    subscribers: number | null;
    totalViews: number | null;
    videos: number | null;
  };
  period: { current: DateRange; previous: DateRange };
  totals: { current: Totals; previous: Totals };
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

/** Pure (unit-tested). */
export function summarizeYouTube(input: {
  channel: RawChannel;
  period: { current: DateRange; previous: DateRange };
  current: Report;
  previous: Report;
  daily: Report;
  top: Report;
  titles: Record<string, string>;
}): YouTubeSummary {
  const cur = totalsOf(reportRows(input.current)[0]);
  const prev = totalsOf(reportRows(input.previous)[0]);
  const ch = (a: number, b: number) => {
    const p = pctChange(a, b);
    return p === null ? null : round(p);
  };
  const s = input.channel.statistics;
  return {
    channel: {
      id: input.channel.id,
      title: input.channel.snippet?.title ?? input.channel.id,
      subscribers: s?.hiddenSubscriberCount
        ? null
        : s?.subscriberCount
          ? Number(s.subscriberCount)
          : null,
      totalViews: s?.viewCount ? Number(s.viewCount) : null,
      videos: s?.videoCount ? Number(s.videoCount) : null,
    },
    period: input.period,
    totals: { current: cur, previous: prev },
    changePct: {
      views: ch(cur.views, prev.views),
      watchMinutes: ch(cur.watchMinutes, prev.watchMinutes),
      netSubscribers: ch(
        cur.subscribersGained - cur.subscribersLost,
        prev.subscribersGained - prev.subscribersLost,
      ),
    },
    daily: reportRows(input.daily)
      .map((r) => ({
        date: String(r.day ?? ''),
        views: Number(r.views ?? 0),
        watchMinutes: Number(r.estimatedMinutesWatched ?? 0),
        netSubscribers: Number(r.subscribersGained ?? 0) - Number(r.subscribersLost ?? 0),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topVideos: reportRows(input.top).map((r) => ({
      id: String(r.video ?? ''),
      title: input.titles[String(r.video ?? '')] ?? String(r.video ?? ''),
      views: Number(r.views ?? 0),
      watchMinutes: Number(r.estimatedMinutesWatched ?? 0),
      avgViewDurationSec: Number(r.averageViewDuration ?? 0),
    })),
  };
}

export async function fetchYouTubeSummary(
  token: string,
  channelId: string,
  now = Date.now(),
): Promise<YouTubeSummary> {
  // YouTube Analytics data is usually 2-3 days behind.
  const period = comparePeriods(now, 3);
  const report = (params: Record<string, string>) => {
    const u = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    u.searchParams.set('ids', 'channel==MINE');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return googleRequest<Report>(u.toString(), { accessToken: token });
  };
  const c = { startDate: period.current.start, endDate: period.current.end };
  const [channels, current, previous, daily, top] = await Promise.all([
    googleRequest<{ items?: RawChannel[] }>(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelId)}`,
      { accessToken: token },
    ),
    report({ ...c, metrics: METRICS }),
    report({ startDate: period.previous.start, endDate: period.previous.end, metrics: METRICS }),
    report({
      ...c,
      metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
      dimensions: 'day',
      sort: 'day',
    }),
    report({
      ...c,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration',
      dimensions: 'video',
      sort: '-views',
      maxResults: '10',
    }),
  ]);
  const ids = reportRows(top)
    .map((r) => String(r.video ?? ''))
    .filter(Boolean);
  const titles: Record<string, string> = {};
  if (ids.length) {
    const v = await googleRequest<{ items?: { id: string; snippet?: { title?: string } }[] }>(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.map(encodeURIComponent).join(',')}`,
      { accessToken: token },
    );
    for (const item of v.items ?? []) titles[item.id] = item.snippet?.title ?? item.id;
  }
  return summarizeYouTube({
    channel: channels.items?.[0] ?? { id: channelId },
    period,
    current,
    previous,
    daily,
    top,
    titles,
  });
}
