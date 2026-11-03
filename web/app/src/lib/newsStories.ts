import type { NewsGroup, NewsItem, NewsReaderData } from '../api/briefing-schema.ts';
import { newsFeed } from './newsFeed.ts';
import { newsStoryId, newsStoryVersion } from '../../../core/brief/news-reader.mjs';
import { canonicalNewsText, newsContext } from '../../../core/brief/news-content.mjs';
export { newsStoryId, newsStoryVersion, newsContext };
export const newsTopicLabel = (topic: string) =>
  topic === 'Головне' ? 'Світ' : topic === 'Винаходи й технології' ? 'Технології' : topic;
export const EMPTY_NEWS_READER: NewsReaderData = {
  following: {},
  mutedUntil: {},
  readVersions: {},
};
export type NewsStory = {
  item: NewsItem;
  topic: string;
  priority: number;
  archived?: boolean;
  knownSaved?: boolean;
};
export function newsStories(
  groups: NewsGroup[],
  muted: string[] = [],
  sources?: string[],
): NewsStory[] {
  const entries = new Map<string, NewsStory>();
  for (const entry of newsFeed(groups, muted, sources)) {
    const id = newsStoryId(entry.item),
      prior = entries.get(id);
    if (!prior) entries.set(id, { ...entry, item: { ...entry.item } });
    else
      prior.item.related = [
        ...(prior.item.related ?? []),
        { title: entry.item.title, url: entry.item.url, publishedAt: entry.item.publishedAt },
        ...(entry.item.related ?? []),
      ].filter((n, i, a) => n.url !== prior.item.url && a.findIndex((x) => x.url === n.url) === i);
  }
  return [...entries.values()];
}
export function newsWasRead(item: NewsItem, reader: NewsReaderData, local: string[]) {
  return (
    (reader.readVersions[newsStoryId(item)] ?? []).includes(newsStoryVersion(item)) ||
    (reader.readVersions[item.url] ?? []).includes(newsStoryVersion(item)) ||
    local.includes(newsReadKey(item)) ||
    local.includes(item.changeAt ? `${item.url}#${item.changeAt}` : item.url)
  );
}
export const newsReadKey = (item: NewsItem) =>
  `story:${newsStoryId(item)}#${newsStoryVersion(item)}`;
export function newsChange(
  item: NewsItem,
  since: string | null | undefined,
  read: boolean,
): 'new' | 'updated' | null {
  if (read) return null;
  const first = Date.parse(item.firstSeenAt ?? item.publishedAt ?? ''),
    changed = Date.parse(item.changeAt ?? '');
  const boundary = Date.parse(since ?? '');
  if (!Number.isFinite(boundary))
    return item.updated && item.changeKind !== 'coverage' ? 'updated' : 'new';
  if (first > boundary) return 'new';
  if (changed > boundary && changed > first) return 'updated';
  return null;
}
export function newsSnapshotKey(groups: NewsGroup[]) {
  return groups
    .flatMap((g) =>
      [...g.items, ...g.more].map(
        (n) =>
          `${newsStoryId(n)}:${newsStoryVersion(n)}:${n.displayVersion ?? ''}:${n.translationStatus ?? n.translated ?? ''}:${
            n.related
              ?.map((r) => r.url)
              .sort()
              .join(',') ?? ''
          }`,
      ),
    )
    .join('|');
}
export type NewsView = {
  mode: 'all' | 'main' | 'interests' | 'following';
  filter: 'all' | 'new' | 'saved';
  topic: string;
  search: string;
  scroll: number;
  snapshot: string;
  limit: number;
};
const VIEW_KEY = 'svitanok:news-view:v3';
export function readNewsView(): NewsView {
  const initial: NewsView = {
    mode: 'all',
    filter: 'all',
    topic: 'Усе',
    search: '',
    scroll: 0,
    snapshot: '',
    limit: 6,
  };
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? '{}');
    return {
      ...initial,
      mode: ['all', 'main', 'interests', 'following'].includes(v.mode) ? v.mode : 'all',
      filter: ['all', 'new', 'saved'].includes(v.filter) ? v.filter : 'all',
      topic: typeof v.topic === 'string' ? v.topic.slice(0, 100) : 'Усе',
      search: typeof v.search === 'string' ? v.search.slice(0, 200) : '',
      scroll: Number.isFinite(v.scroll) ? Math.max(0, Math.min(100000, v.scroll)) : 0,
      snapshot: typeof v.snapshot === 'string' ? v.snapshot : '',
      limit: Number.isFinite(v.limit) ? Math.max(6, Math.min(300, Math.floor(v.limit))) : 6,
    };
  } catch {
    return initial;
  }
}
export function saveNewsView(view: NewsView) {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    /* Optional session storage. */
  }
}
export function changedNewsWords(before: string, after: string) {
  const old = new Set(canonicalNewsText(before).split(' '));
  return after
    .split(/(\s+)/)
    .map((text) => ({ text, changed: !!text.trim() && !old.has(canonicalNewsText(text)) }));
}
