// Six public RSS fetches and at most one cached translation per 3-hour cycle.
// This snapshot is separate from the morning briefing and never overwrites it.
import { localizeNewsGroups } from './news-localization.mjs';
import { normalizeSettings } from '../../settings-core.mjs';
import { DEFAULT_NEWS_SOURCES, NEWS_FEEDS } from './news-catalog.mjs';
export const NEWS_SNAPSHOT_KEY = 'miniAppNewsSnapshot';
export const NEWS_INTERVAL_MS = 3 * 60 * 60 * 1000;
const SOURCES = NEWS_FEEDS;

const entities = /** @type {Record<string, string>} */ ({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
});
/** @param {string} text */
const clean = (text) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (s) => entities[s] ?? s)
    .replace(/&#(\d+);/g, (_, n) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      Number.parseInt(n, 16) < 0x110000 ? String.fromCodePoint(Number.parseInt(n, 16)) : '',
    )
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** @param {string} xml @param {number} nowMs */
export function parseNewsFeed(xml, nowMs) {
  /** @type {{title: string, url: string, publishedAt: string, image?: string, excerpt?: string}[]} */ const items =
    [];
  const seen = new Set();
  for (const block of xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []) {
    const title = clean(block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 300);
    const rawLink =
      block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1] ??
      block.match(/<link\b[^>]*href=["']([^"']+)/i)?.[1] ??
      '';
    const link = clean(rawLink);
    const at = Date.parse(
      clean(block.match(/<(pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? ''),
    );
    // Undated / future / stale items are not presented as current-day news.
    if (
      !title ||
      /\b(?:quiz(?:zes)?|brainteaser|crossword)\b/i.test(title) ||
      /\/iplayer\//i.test(link) ||
      !/^https?:\/\//i.test(link) ||
      !Number.isFinite(at) ||
      at > nowMs + 60000 ||
      at < nowMs - 48 * 3600000
    )
      continue;
    let url;
    try {
      const parsed = new URL(link);
      if (parsed.username || parsed.password) continue;
      parsed.hash = '';
      ['utm_source', 'utm_medium', 'utm_campaign', 'at_medium', 'at_campaign'].forEach((key) =>
        parsed.searchParams.delete(key),
      );
      url = parsed.href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const excerpt = clean(
      block.match(/<(description|summary)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? '',
    ).slice(0, 400);
    let image;
    const imageLink = clean(
      block.match(/<media:(?:content|thumbnail)\b[^>]*url=["']([^"']+)/i)?.[1] ?? '',
    );
    try {
      const u = new URL(imageLink);
      if (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !/^(localhost|127\.|\[|10\.|192\.168\.)/i.test(u.hostname)
      )
        image = u.href;
    } catch {
      /* Image is optional. */
    }
    items.push({
      title,
      url,
      publishedAt: new Date(at).toISOString(),
      ...(excerpt ? { excerpt } : {}),
      ...(image ? { image } : {}),
    });
  }
  return items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3);
}
/** @param {Env} env @param {number} [nowMs] @param {typeof fetch} [fetchImpl] */
export async function refreshNewsSnapshot(env, nowMs = Date.now(), fetchImpl = fetch) {
  let rawSettings;
  try {
    rawSettings = JSON.parse((await env.BRIEFING.get('settings')) ?? 'null');
  } catch {
    /* Use defaults. */
  }
  const settings = normalizeSettings(rawSettings);
  if (settings.modules.news === false) return { skipped: 'disabled' };
  const interval = (settings.news?.intervalHours ?? 3) * 3600000;
  const allowed = settings.news?.sources ?? DEFAULT_NEWS_SOURCES;
  const configKey = JSON.stringify({
    catalogVersion: 2,
    allowed,
    interval,
    muted: settings.mutedTopics,
  });
  /** @param {{source:string,topic:string}} source */
  const enabled = (source) =>
    allowed.some((name) => name === source.source) &&
    !settings.mutedTopics.includes(source.topic) &&
    !(source.topic === 'CS2' && settings.mutedTopics.includes('Кіберспорт')) &&
    !(source.topic === 'Винаходи й технології' && settings.mutedTopics.includes('Тех/IT')) &&
    !(source.topic === 'Головне' && settings.mutedTopics.includes('Світ'));
  /** @type {KvBlob|null} */ let old = null;
  try {
    old = JSON.parse((await env.BRIEFING.get(NEWS_SNAPSHOT_KEY)) ?? 'null');
  } catch {
    /* Rebuild malformed cache. */
  }
  if (
    old?.attemptedAt &&
    (old.configKey === configKey ||
      (old.catalogVersion === 2 &&
        old.configKey == null &&
        !settings.news &&
        settings.mutedTopics.length === 0)) &&
    nowMs - Date.parse(String(old.attemptedAt)) < interval
  )
    return { skipped: 'fresh' };
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      if (!enabled(source)) return { source, items: [] };
      const response = await fetchImpl(source.url, {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'SvitanokNewsBot/1.0 (+https://github.com/yushkonazar/svitanok)' },
      });
      if (!response.ok) throw new Error(`RSS ${response.status}`);
      const xml = await response.text();
      if (xml.length > 1500000) throw new Error('RSS oversized');
      return { source, items: parseNewsFeed(xml, nowMs) };
    }),
  );
  /** @type {KvBlob[]} */ const groups = [];
  /** @type {KvBlob[]} */ const status = [];
  results.forEach((result, i) => {
    const source = SOURCES[i];
    if (!source) return;
    status.push({ name: source.name, ok: result.status === 'fulfilled', enabled: enabled(source) });
    if (result.status === 'fulfilled')
      groups.push({
        sourceId: source.id,
        scope: source.scope,
        topic: source.topic,
        items: result.value.items,
        more: [],
      });
    else {
      // Keep a source's previous items only within the same bounded freshness window.
      const previous = Array.isArray(old?.groups)
        ? old.groups.find((/** @type {KvBlob} */ group) => group.sourceId === source.id)
        : null;
      const items = Array.isArray(previous?.items)
        ? previous.items.filter(
            (/** @type {KvBlob} */ item) => Date.parse(item.publishedAt) >= nowMs - 48 * 3600000,
          )
        : [];
      groups.push({
        sourceId: source.id,
        scope: source.scope,
        topic: source.topic,
        items,
        more: [],
      });
    }
  });
  // Round-robin selection preserves small sources; total <= 18, no duplicate URLs.
  /** @type {KvBlob[][]} */ const selected = groups.map(() => []);
  const seen = new Set();
  let count = 0;
  for (let rank = 0; rank < 3; rank++)
    for (let i = 0; i < groups.length; i++) {
      const item = groups[i]?.items[rank];
      if (!item || seen.has(item.url) || count >= 18) continue;
      seen.add(item.url);
      selected[i]?.push(item);
      count++;
    }
  groups.forEach((group, i) => {
    group.items = selected[i] ?? [];
  });
  const successful =
    !SOURCES.some(enabled) ||
    results.some((r, i) => r.status === 'fulfilled' && SOURCES[i] && enabled(SOURCES[i]));
  const localization = await localizeNewsGroups(env, groups, old);
  const snapshot = {
    configKey,
    catalogVersion: 2,
    intervalHours: settings.news?.intervalHours ?? 3,
    groups,
    localization,
    sources: status,
    attemptedAt: new Date(nowMs).toISOString(),
    generatedAt: successful ? new Date(nowMs).toISOString() : (old?.generatedAt ?? null),
  };
  await env.BRIEFING.put(NEWS_SNAPSHOT_KEY, JSON.stringify(snapshot));
  return { updated: successful };
}
