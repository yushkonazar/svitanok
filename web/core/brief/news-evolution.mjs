import { newsFingerprint, cleanNewsText, canonicalNewsText } from './news-content.mjs';

/** Bounded history of observed public articles; no model call or private user data.
 * Exact URLs, corroborating links or an editor-assigned known history ID establish a thread.
 * @param {KvBlob[]} groups @param {KvBlob[]} history @param {number} nowMs
 * @param {{followed?:string[]}} [options] */
export async function evolveNews(groups, history = [], nowMs = Date.now(), options = {}) {
  const followed = new Set(options.followed ?? []);
  const recent = (Array.isArray(history) ? history : []).filter(
    (n) =>
      Number.isFinite(Date.parse(n.observedAt)) &&
      nowMs - Date.parse(n.observedAt) < (followed.has(n.storyId) ? 30 * 86400000 : 72 * 3600000),
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
      const rawTitle = cleanNewsText(item.originalTitle ?? item.title),
        rawSource = cleanNewsText(item.sourceExcerpt ?? item.excerpt ?? '');
      const legacyKey = await newsFingerprint(
        JSON.stringify([
          cleanNewsText(item.originalTitle ?? item.title),
          cleanNewsText(item.sourceExcerpt ?? item.excerpt ?? ''),
        ]),
      );
      const contentKey = await newsFingerprint(
        JSON.stringify([canonicalNewsText(rawTitle), canonicalNewsText(rawSource)]),
      );
      const storyId = prior?.storyId ?? (await newsFingerprint(item.url));
      const changed = !!prior && prior.contentKey !== contentKey && prior.contentKey !== legacyKey;
      const facts =
        changed &&
        (item.development === true || (prior.url === item.url && item.development !== false));
      item.storyId = storyId;
      item.firstSeenAt = prior?.firstSeenAt ?? new Date(nowMs).toISOString();
      item.changeAt = facts ? new Date(nowMs).toISOString() : (prior?.changeAt ?? item.firstSeenAt);
      item.updated = changed || !!prior?.updated;
      item.contentVersion = facts
        ? contentKey
        : (prior?.contentVersion ?? prior?.contentKey ?? contentKey);
      item.changeKind = facts ? 'facts' : changed ? 'coverage' : prior?.changeKind;
      item.displayVersion = await newsFingerprint(
        JSON.stringify([item.title, item.why ?? '', item.image ?? '', item.related ?? []]),
      );
      if (changed) {
        item.previousTitle = prior.title;
        item.previousSummary = prior.summary;
        item.previousChangeAt = prior.changeAt;
        item.changeLabel =
          prior.url === item.url ? 'Джерело оновило матеріал' : 'Ще матеріал про цю подію';
      } else if (prior?.updated) {
        item.previousTitle = prior.previousTitle;
        item.previousSummary = prior.previousSummary;
        item.previousChangeAt = prior.previousChangeAt;
        item.changeLabel = prior.changeLabel;
      }
      next.set(storyId, {
        storyId,
        urls: [...new Set([...(prior?.urls ?? []), ...urls])].slice(-12),
        url: item.url,
        contentKey,
        contentVersion: item.contentVersion,
        changeKind: item.changeKind,
        sourceText: rawSource.slice(0, 2400),
        originalTitle: rawTitle,
        title: item.title,
        summary: item.why ?? '',
        firstSeenAt: item.firstSeenAt,
        changeAt: item.changeAt,
        updated: item.updated,
        previousTitle: item.previousTitle,
        previousSummary: item.previousSummary,
        previousChangeAt: item.previousChangeAt,
        changeLabel: item.changeLabel,
        observedAt: new Date(nowMs).toISOString(),
      });
    }
  const bounded = [];
  let bytes = 2;
  for (const row of [...next.values()]
    .sort(
      (a, b) =>
        Number(followed.has(b.storyId)) - Number(followed.has(a.storyId)) ||
        b.observedAt.localeCompare(a.observedAt),
    )
    .slice(0, 300)) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (bytes + size > 512 * 1024) continue;
    bytes += size;
    bounded.push(row);
  }
  return bounded;
}
