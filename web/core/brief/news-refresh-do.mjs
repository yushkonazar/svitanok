import { DurableObject } from 'cloudflare:workers';
import { buildNewsSnapshot, NEWS_SNAPSHOT_KEY, readNewsSnapshot } from './news-snapshot.mjs';
import {
  normalizeNewsReader,
  applyNewsReaderAction,
  newsStoryId,
  newsStoryVersion,
  compactNewsItem,
} from './news-reader.mjs';
export class NewsRefreshDO extends DurableObject {
  #operations = Promise.resolve();
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  #serial(work) {
    const next = this.#operations.then(work, work);
    this.#operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async getSnapshot() {
    return (
      (await this.ctx.storage.get('snapshot')) ??
      (await readNewsSnapshot(/** @type {Env} */ (this.env)))
    );
  }
  async getFeedback() {
    return /** @type {KvBlob} */ ((await this.ctx.storage.get('feedback')) ?? {});
  }
  async getLastSeen() {
    return (await this.ctx.storage.get('lastSeenAt')) ?? null;
  }
  async getReader() {
    return normalizeNewsReader(await this.ctx.storage.get('reader'));
  }
  /** @param {string} key @param {string} action @param {string|undefined} version */
  async storyAction(key, action, version) {
    return this.#serial(async () => {
      const snapshot = /** @type {KvBlob|null} */ (await this.getSnapshot()),
        reader = await this.getReader();
      const recent = /** @type {KvBlob} */ ((await this.ctx.storage.get('recentStories')) ?? {});
      let story = snapshot?.groups
        ?.flatMap((/** @type {KvBlob} */ g) =>
          (g.items ?? []).map((/** @type {KvBlob} */ item) => ({
            topic: g.topic,
            scope: g.scope,
            item,
          })),
        )
        .find((/** @type {KvBlob} */ n) => newsStoryId(n.item) === key || n.item.url === key);
      story ??= Object.values(recent).find(
        (n) =>
          (newsStoryId(n.item) === key || n.item.url === key) && Date.now() - n.at < 3 * 86400000,
      );
      story ??= Object.hasOwn(reader.following, key) ? reader.following[key] : undefined;
      // Saved archive records may outlive the public snapshot. Their URL/version
      // can be marked read without fetching arbitrary URLs or creating follows.
      if (!story && ['read', 'unread'].includes(action) && version === key) {
        try {
          const url = new URL(key);
          if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
            story = { item: { title: '', url: key } };
        } catch {
          /* An unknown non-URL story is still rejected below. */
        }
      }
      if (
        !story &&
        ['unfollow', 'unmute'].includes(action) &&
        (Object.hasOwn(reader.following, key) || Object.hasOwn(reader.mutedUntil, key))
      )
        story = { item: { storyId: key, url: key, title: '' } };
      if (!story) return { ok: false, error: 'Подію вже не знайдено. Онови стрічку.' };
      const id = newsStoryId(story.item);
      if (['read', 'unread'].includes(action)) {
        const known = new Set([
          newsStoryVersion(story.item),
          ...(recent[id]?.versions ?? []),
          ...(reader.readVersions[id] ?? []),
        ]);
        if (!version || !known.has(version))
          return { ok: false, error: 'Версія події вже змінилася. Онови стрічку.' };
      }
      const result = applyNewsReaderAction(reader, story, action, version);
      if (result.ok) await this.ctx.storage.put('reader', result.reader);
      return result;
    });
  }
  async seen() {
    return this.#serial(async () => {
      const lastSeenAt = new Date().toISOString();
      await this.ctx.storage.put('lastSeenAt', lastSeenAt);
      return { ok: true, lastSeenAt };
    });
  }
  /** @param {number} nowMs @param {boolean} [force] */
  async refresh(nowMs, force = false) {
    return this.#serial(async () => {
      const old = /** @type {KvBlob|null} */ (await this.getSnapshot());
      const profile = await this.getFeedback();
      let reader = await this.getReader();
      /** @type {Record<string,number>} */ const preferences = {};
      for (const n of Object.values(profile))
        if (n.kind !== 'clear') {
          const key =
            n.reason === 'source' && n.sourceId
              ? `source:${n.sourceId}`
              : n.reason === 'repeat' || n.reason === 'weak'
                ? `article:${n.url}`
                : n.topic;
          preferences[key] = (preferences[key] ?? 0) + (n.kind === 'like' ? 1 : -1);
        }
      for (const id of Object.keys(reader.following)) preferences[`story:${id}`] = 1;
      const result = await buildNewsSnapshot(/** @type {Env} */ (this.env), nowMs, fetch, {
        old,
        force,
        preferences,
      });
      if (result.snapshot) {
        const stories = /** @type {KvBlob} */ ((await this.ctx.storage.get('recentStories')) ?? {});
        for (const snap of [old, result.snapshot])
          for (const group of snap?.groups ?? [])
            for (const item of group.items ?? []) {
              const id = newsStoryId(item),
                version = newsStoryVersion(item);
              const story = { topic: group.topic, scope: group.scope, item: compactNewsItem(item) };
              stories[id] = {
                ...story,
                versions: [...new Set([...(stories[id]?.versions ?? []), version])].slice(-4),
                at: nowMs,
              };
              if (reader.following[id])
                reader = applyNewsReaderAction(reader, story, 'follow', undefined, nowMs).reader;
            }
        const boundedStories = /** @type {KvBlob} */ ({});
        let bytes = 2;
        for (const [id, story] of Object.entries(stories)
          .filter(([, s]) => nowMs - s.at < 3 * 86400000)
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, 100)) {
          const size = new TextEncoder().encode(JSON.stringify({ [id]: story })).length;
          if (bytes + size > 96 * 1024) continue;
          bytes += size;
          boundedStories[id] = story;
        }
        await this.ctx.storage.put('recentStories', boundedStories);
        await this.ctx.storage.put('reader', reader);
        // A reader may keep the previous stream open after a background refresh.
        // Keep bounded known article IDs so their reactions still have a valid topic.
        const known = /** @type {KvBlob} */ ((await this.ctx.storage.get('recentArticles')) ?? {});
        for (const snapshot of [old, result.snapshot])
          for (const group of snapshot?.groups ?? [])
            for (const item of group.items ?? [])
              known[item.url] = { topic: group.topic, sourceId: group.sourceId, at: nowMs };
        const recent = Object.fromEntries(
          Object.entries(known)
            .filter(([, n]) => nowMs - Number(n.at) < 3 * 86400000)
            .sort((a, b) => Number(b[1].at) - Number(a[1].at))
            .slice(0, 300),
        );
        await this.ctx.storage.put('recentArticles', recent);
        await this.ctx.storage.put('snapshot', result.snapshot);
        await this.env.BRIEFING.put(NEWS_SNAPSHOT_KEY, JSON.stringify(result.snapshot));
      }
      const status = { ...result };
      delete status.snapshot;
      return status;
    });
  }
  /** @param {string} url @param {'like'|'less'|'clear'} kind @param {string} [reason] */
  async feedback(url, kind, reason) {
    return this.#serial(async () => {
      const snapshot = /** @type {KvBlob|null} */ (await this.getSnapshot());
      const group = snapshot?.groups?.find((/** @type {KvBlob} */ g) =>
        g.items.some((/** @type {KvBlob} */ n) => n.url === url),
      );
      const recent = /** @type {KvBlob} */ ((await this.ctx.storage.get('recentArticles')) ?? {});
      const known = recent[url];
      const topic =
        group?.topic ??
        (known && Date.now() - Number(known.at) < 3 * 86400000 ? known.topic : null);
      if (!topic) return { ok: false, error: 'article-not-found' };
      const profile = await this.getFeedback();
      delete profile[url];
      profile[url] = {
        kind,
        topic,
        url,
        sourceId: group?.sourceId ?? known?.sourceId,
        ...(kind === 'less' && ['topic', 'repeat', 'weak', 'source'].includes(reason ?? '')
          ? { reason }
          : {}),
        at: Date.now(),
      };
      const bounded = Object.fromEntries(Object.entries(profile).slice(-300));
      await this.ctx.storage.put('feedback', bounded);
      return {
        ok: true,
        feedback: Object.fromEntries(
          Object.entries(bounded).map(([key, value]) => [key, value.kind]),
        ),
      };
    });
  }
}
