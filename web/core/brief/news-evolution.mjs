import { newsFingerprint, cleanNewsText } from './news-content.mjs';

/** Bounded history of observed public articles; no model call or private user data.
 * Exact URLs, corroborating links or an editor-assigned known history ID establish a thread.
 * @param {KvBlob[]} groups @param {KvBlob[]} history @param {number} nowMs */
export async function evolveNews(groups, history = [], nowMs = Date.now()) {
  const recent = (Array.isArray(history) ? history : []).filter(
    (n) =>
      Number.isFinite(Date.parse(n.observedAt)) && nowMs - Date.parse(n.observedAt) < 72 * 3600000,
  );
  const byUrl = new Map(
    recent.flatMap((n) => (n.urls ?? []).map((/** @type {string} */ url) => [url, n])),
  );
  const next = new Map(recent.map((n) => [n.storyId, n]));
  for (const group of groups)
    for (const item of group.items ?? []) {
      const urls = [
        ...new Set([item.url, ...(item.related ?? []).map((/** @type {KvBlob} */ n) => n.url)]),
      ];
      const prior =
        urls.map((url) => byUrl.get(url)).find(Boolean) ??
        recent.find((n) => n.storyId === item.historyStoryId);
      const contentKey = await newsFingerprint(
        JSON.stringify([
          cleanNewsText(item.originalTitle ?? item.title),
          cleanNewsText(item.sourceExcerpt ?? item.excerpt ?? ''),
        ]),
      );
      const storyId = prior?.storyId ?? (await newsFingerprint(item.url));
      const changed = !!prior && prior.contentKey !== contentKey;
      item.storyId = storyId;
      item.firstSeenAt = prior?.firstSeenAt ?? new Date(nowMs).toISOString();
      item.changeAt = changed
        ? new Date(nowMs).toISOString()
        : (prior?.changeAt ?? item.firstSeenAt);
      item.updated = changed || !!prior?.updated;
      if (changed) {
        item.previousTitle = prior.title;
        item.previousSummary = prior.summary;
        item.changeLabel =
          prior.url === item.url ? 'Джерело оновило матеріал' : 'Ще матеріал про цю подію';
      } else if (prior?.updated) {
        item.previousTitle = prior.previousTitle;
        item.previousSummary = prior.previousSummary;
        item.changeLabel = prior.changeLabel;
      }
      next.set(storyId, {
        storyId,
        urls: [...new Set([...(prior?.urls ?? []), ...urls])].slice(-12),
        url: item.url,
        contentKey,
        title: item.title,
        summary: item.why ?? '',
        firstSeenAt: item.firstSeenAt,
        changeAt: item.changeAt,
        updated: item.updated,
        previousTitle: item.previousTitle,
        previousSummary: item.previousSummary,
        changeLabel: item.changeLabel,
        observedAt: new Date(nowMs).toISOString(),
      });
    }
  return [...next.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 300);
}
