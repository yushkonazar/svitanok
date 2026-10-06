// Six default public RSS feeds, one cached selection and one translation batch per cycle.
// This snapshot is separate from the morning briefing and never overwrites it.
import { localizeNewsGroups } from './news-localization.mjs';
import { normalizeSettings } from '../../settings-core.mjs';
import { DEFAULT_NEWS_SOURCES, NEWS_FEEDS } from './news-catalog.mjs';
import { cleanNewsText, decodeNewsText, safeNewsImage, newsFingerprint } from './news-content.mjs';
import { curateNewsGroups } from './news-curation.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
export const NEWS_SNAPSHOT_KEY = 'miniAppNewsSnapshot';
export const NEWS_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** @param {Env} env @returns {Promise<KvBlob|null>} */
export async function readNewsSnapshot(env) {
  try {
    return JSON.parse((await env.BRIEFING.get(NEWS_SNAPSHOT_KEY)) ?? 'null');
  } catch {
    return null;
  }
}
const SOURCES = NEWS_FEEDS;

const clean = cleanNewsText;
/** @param {string} xml @param {number} nowMs @param {{limit?:number,britishTime?:boolean}} [options] */
export function parseNewsFeed(xml, nowMs, options = {}) {
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
    const dateText = clean(
      block.match(/<(pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? '',
    );
    // Sky uses British Summer Time, unsupported by Date.parse in workerd/Node.
    const at = Date.parse(options.britishTime ? dateText.replace(/\bBST\b/g, '+0100') : dateText);
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
    const attrs = (/** @type {string} */ tag) =>
      Object.fromEntries(
        [...tag.matchAll(/([\w:-]+)=["']([^"']*)["']/g)].map((m) => [
          m[1],
          decodeNewsText(m[2] ?? ''),
        ]),
      );
    const tags = block.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi) ?? [];
    const candidates = tags
      .map(attrs)
      .filter((a) => !a.type || a.type.startsWith('image/'))
      .map((a) => a.url ?? '');
    const description = decodeNewsText(
      block.match(/<(description|summary)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? '',
    );
    for (const tag of description.match(/<img\b[^>]*>/gi) ?? [])
      candidates.push(attrs(tag).src ?? '');
    image = candidates.map(safeNewsImage).find(Boolean) ?? undefined;
    items.push({
      title,
      url,
      publishedAt: new Date(at).toISOString(),
      ...(excerpt ? { excerpt } : {}),
      ...(image ? { image } : {}),
    });
  }
  return items
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, options.limit ?? 3);
}
/** @param {Env} env @param {number} nowMs @param {typeof fetch} fetchImpl
 * @param {{old?:KvBlob|null,force?:boolean,preferences?:Record<string,number>}} [options]
 * @returns {Promise<KvBlob>} */
export async function buildNewsSnapshot(env, nowMs, fetchImpl, options = {}) {
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
    catalogVersion: 3,
    translationService: env.GOOGLE_TRANSLATE_API_KEY
      ? 'google'
      : env.GEMINI_API_KEY && env.GEMINI_TIER === 'paid'
        ? 'gemini'
        : 'unconfigured',
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
  /** @type {KvBlob|null} */ let old = options.old ?? null;
  if (options.old === undefined)
    try {
      old = JSON.parse((await env.BRIEFING.get(NEWS_SNAPSHOT_KEY)) ?? 'null');
    } catch {
      /* Rebuild malformed cache. */
    }
  const elapsed = old?.attemptedAt ? nowMs - Date.parse(String(old.attemptedAt)) : Infinity;
  if (options.force && old?.catalogVersion === 3 && elapsed < 10 * 60000)
    return { skipped: 'cooldown', retryAfterSeconds: Math.ceil((10 * 60000 - elapsed) / 1000) };
  if (
    old?.attemptedAt &&
    old.configKey === configKey &&
    !options.force &&
    elapsed <
      (old.localization?.pending &&
      (env.GOOGLE_TRANSLATE_API_KEY || (env.GEMINI_API_KEY && env.GEMINI_TIER === 'paid'))
        ? Math.min(interval, 30 * 60000)
        : interval)
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
      const rawCount = (xml.match(/<(?:item|entry)\b/gi) ?? []).length;
      return {
        source,
        rawCount,
        items: parseNewsFeed(xml, nowMs, { limit: 15, britishTime: source.id === 'sky-football' }),
      };
    }),
  );
  /** @type {KvBlob[]} */ const groups = [];
  /** @type {KvBlob[]} */ const status = [];
  results.forEach((result, i) => {
    const source = SOURCES[i];
    if (!source) return;
    status.push({
      name: source.name,
      ok: result.status === 'fulfilled',
      enabled: enabled(source),
      count: result.status === 'fulfilled' ? result.value.items.length : 0,
      state: !enabled(source)
        ? 'disabled'
        : result.status === 'rejected'
          ? 'unavailable'
          : result.value.items.length
            ? 'ready'
            : result.value.rawCount
              ? 'no-recent-items'
              : 'empty',
    });
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
  const curation = await curateNewsGroups(env, groups, nowMs, options.preferences);
  groups.splice(0, groups.length, ...curation.groups);
  const successful =
    !SOURCES.some(enabled) ||
    results.some((r, i) => r.status === 'fulfilled' && SOURCES[i] && enabled(SOURCES[i]));
  const localization = await localizeNewsGroups(env, groups, old, undefined, nowMs);
  const previous = new Map(
    (old?.groups ?? [])
      .flatMap((/** @type {KvBlob} */ g) => g.items ?? [])
      .map((/** @type {KvBlob} */ item) => [item.url, item]),
  );
  for (const g of groups)
    for (const item of g.items) {
      const prior = previous.get(item.url);
      if (prior?.translationKey && prior.translationKey !== item.translationKey)
        item.updated = true;
      if (item.image) {
        item.imageId = await newsFingerprint(item.image);
        item.imageProxy = `/api/news/image/${item.imageId}`;
      }
    }
  const period = kyivDateKey(new Date(nowMs)).slice(0, 7);
  let usage = { period, translatedCharacters: 0, editorCalls: 0, estimatedEditorUsd: 0, cycles: 0 };
  try {
    const prior = JSON.parse((await env.BRIEFING.get('miniAppNewsUsage')) ?? 'null');
    if (prior?.period === period) usage = prior;
  } catch {
    /* new counter */
  }
  usage.translatedCharacters += localization.characters;
  usage.editorCalls += curation.editorial.requests + localization.editorCalls;
  usage.estimatedEditorUsd +=
    Number(curation.editorial.usage?.estimatedUsd ?? 0) +
    Number(localization.usage?.estimatedUsd ?? 0);
  usage.cycles++;
  await env.BRIEFING.put('miniAppNewsUsage', JSON.stringify(usage));
  const snapshot = {
    configKey,
    catalogVersion: 3,
    intervalHours: settings.news?.intervalHours ?? 3,
    groups,
    localization,
    editorial: curation.editorial,
    usage,
    sources: status,
    attemptedAt: new Date(nowMs).toISOString(),
    generatedAt: successful ? new Date(nowMs).toISOString() : (old?.generatedAt ?? null),
  };
  return { updated: successful, snapshot };
}
/** @param {Env} env @returns {any|null} */
export const newsRefreshStub = (env) =>
  typeof env.NEWS_REFRESH?.getByName === 'function'
    ? env.NEWS_REFRESH.getByName('mini-app-news')
    : null;
// Tests and rollback environments without the DO retain the cache path.
/** @param {Env} env @param {number} [nowMs] @param {typeof fetch} [fetchImpl] @param {boolean} [force] */
export async function refreshNewsSnapshot(
  env,
  nowMs = Date.now(),
  fetchImpl = fetch,
  force = false,
) {
  const target = newsRefreshStub(env);
  if (target) return target.refresh(nowMs, force);
  const result = await buildNewsSnapshot(env, nowMs, fetchImpl, { force });
  if (result.snapshot) await env.BRIEFING.put(NEWS_SNAPSHOT_KEY, JSON.stringify(result.snapshot));
  const status = { ...result };
  delete status.snapshot;
  return status;
}
