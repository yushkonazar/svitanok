import { DurableObject } from 'cloudflare:workers';
import { buildNewsSnapshot, NEWS_SNAPSHOT_KEY, readNewsSnapshot } from './news-snapshot.mjs';
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
      /** @type {Record<string,number>} */ const preferences = {};
      for (const n of Object.values(profile))
        if (n.kind !== 'clear')
          preferences[n.topic] = (preferences[n.topic] ?? 0) + (n.kind === 'like' ? 1 : -1);
      const result = await buildNewsSnapshot(/** @type {Env} */ (this.env), nowMs, fetch, {
        old,
        force,
        preferences,
      });
      if (result.snapshot) {
        // A reader may keep the previous stream open after a background refresh.
        // Keep bounded known article IDs so their reactions still have a valid topic.
        const known = /** @type {KvBlob} */ ((await this.ctx.storage.get('recentArticles')) ?? {});
        for (const snapshot of [old, result.snapshot])
          for (const group of snapshot?.groups ?? [])
            for (const item of group.items ?? [])
              known[item.url] = { topic: group.topic, at: nowMs };
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
  /** @param {string} url @param {'like'|'less'|'clear'} kind */
  async feedback(url, kind) {
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
      profile[url] = { kind, topic, at: Date.now() };
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
