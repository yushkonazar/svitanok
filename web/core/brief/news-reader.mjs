/** Reader choices are separate from the public snapshot and editorial feedback. */
export const emptyNewsReader = () => ({ following: {}, mutedUntil: {}, readVersions: {} });
/** @param {unknown} value @param {number} [nowMs] @returns {KvBlob} */
export function normalizeNewsReader(value, nowMs = Date.now()) {
  const v = /** @type {KvBlob} */ (value ?? {}),
    out = /** @type {KvBlob} */ (emptyNewsReader());
  const records = (/** @type {unknown} */ x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.entries(x) : [];
  out.following = Object.fromEntries(
    records(v.following)
      .filter(
        ([, n]) =>
          n &&
          typeof n === 'object' &&
          typeof n.item?.url === 'string' &&
          typeof n.item?.title === 'string',
      )
      .slice(-20),
  );
  out.mutedUntil = Object.fromEntries(
    records(v.mutedUntil)
      .filter(([, n]) => typeof n === 'string' && Date.parse(n) > nowMs)
      .slice(-50),
  );
  out.readVersions = Object.fromEntries(
    records(v.readVersions)
      .filter(
        ([, n]) => Array.isArray(n) && n.every((x) => typeof x === 'string' && x.length <= 2000),
      )
      .slice(-300)
      .map(([k, n]) => [k, n.slice(-4)]),
  );
  while (
    new TextEncoder().encode(JSON.stringify(out)).length > 96 * 1024 &&
    Object.keys(out.readVersions).length
  ) {
    const oldest = Object.keys(out.readVersions)[0];
    if (!oldest) break;
    delete out.readVersions[oldest];
  }
  return out;
}
/** @param {KvBlob} item */
export const newsStoryId = (item) => item.storyId ?? item.url;
/** @param {KvBlob} item */
export const newsStoryVersion = (item) =>
  item.contentVersion ?? item.changeAt ?? item.publishedAt ?? item.url;
/** @param {KvBlob} item @returns {KvBlob} */
export function compactNewsItem(item) {
  return {
    storyId: newsStoryId(item),
    contentVersion: newsStoryVersion(item),
    title: String(item.title).slice(0, 300),
    url: String(item.url).slice(0, 2000),
    why: String(item.why ?? '').slice(0, 240),
    publishedAt: item.publishedAt,
    firstSeenAt: item.firstSeenAt,
    changeAt: item.changeAt,
    priority: item.priority,
  };
}
/** Explicit operations are retry-safe; different read versions coexist.
 * @param {unknown} current @param {KvBlob} story @param {string} action @param {string|undefined} version @param {number} [nowMs]
 * @returns {{ok:boolean,reader:KvBlob,error?:string}} */
export function applyNewsReaderAction(current, story, action, version, nowMs = Date.now()) {
  const reader = normalizeNewsReader(structuredClone(current ?? emptyNewsReader()), nowMs),
    item = story.item ?? story,
    id = newsStoryId(item);
  if (!id || !item.url || ['__proto__', 'constructor', 'prototype'].includes(id))
    return { ok: false, reader, error: 'Подію вже не знайдено. Онови стрічку.' };
  if (action === 'follow') {
    if (!reader.following[id] && Object.keys(reader.following).length >= 20)
      return {
        ok: false,
        reader,
        error: 'Можна стежити за 20 подіями. Прибери завершену історію.',
      };
    reader.following[id] = {
      followedAt: reader.following[id]?.followedAt ?? new Date(nowMs).toISOString(),
      topic: String(story.topic ?? 'Головне').slice(0, 100),
      scope: story.scope === 'ua' ? 'ua' : 'world',
      item: compactNewsItem(item),
    };
  } else if (action === 'unfollow') delete reader.following[id];
  else if (action === 'mute') reader.mutedUntil[id] = new Date(nowMs + 86400000).toISOString();
  else if (action === 'unmute') delete reader.mutedUntil[id];
  else if (action === 'read' || action === 'unread') {
    if (!version) return { ok: false, reader, error: 'Не вказана версія матеріалу.' };
    const prior = reader.readVersions[id] ?? [];
    delete reader.readVersions[id];
    reader.readVersions[id] = [
      ...prior.filter((/** @type {string} */ v) => v !== version),
      ...(action === 'read' ? [version] : []),
    ].slice(-4);
  } else return { ok: false, reader, error: 'Невідома дія.' };
  const normalized = normalizeNewsReader(reader, nowMs);
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > 96 * 1024)
    return {
      ok: false,
      reader: normalizeNewsReader(current, nowMs),
      error: 'Підсумок стеження завеликий. Прибери завершену історію.',
    };
  return { ok: true, reader: normalized };
}
