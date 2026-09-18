import { DurableObject } from 'cloudflare:workers';
import { WEEKLY_REVIEW_STATE_KEY } from './contract.mjs';
const STATE_KEY = 'state';
const LEASE_KEY = 'lease';
export class WeeklyReviewStateDO extends DurableObject {
  #ops = Promise.resolve();
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */ #serial(work) {
    const next = this.#ops.then(work, work);
    this.#ops = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /** @param {unknown} legacy */ async #read(legacy) {
    const old = await this.ctx.storage.get(STATE_KEY);
    if (old !== undefined) return old;
    await this.ctx.storage.put(STATE_KEY, legacy ?? null);
    return legacy ?? null;
  }
  /** @param {unknown} legacy @param {number} nowMs @param {number} leaseMs */ async claim(
    legacy,
    nowMs,
    leaseMs,
  ) {
    return this.#serial(async () => {
      const state = await this.#read(legacy);
      const lease = /** @type {{token?: string,untilMs?: number}|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (lease?.token && Number(lease.untilMs) > nowMs) return { ok: false, reason: 'busy' };
      const token = crypto.randomUUID();
      await this.ctx.storage.put(LEASE_KEY, {
        token,
        untilMs: nowMs + Math.max(1, Number(leaseMs) || 0),
      });
      return { ok: true, token, state };
    });
  }
  /** @param {string|null|undefined} token @param {unknown} state */ async complete(token, state) {
    return this.#serial(async () => {
      const lease = /** @type {{token?: string}|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (!token || lease?.token !== token) return false;
      await this.ctx.storage.put(STATE_KEY, state ?? null);
      await this.ctx.storage.delete(LEASE_KEY);
      try {
        await this.env.BRIEFING?.put?.(WEEKLY_REVIEW_STATE_KEY, JSON.stringify(state));
      } catch (/** @type {any} */ error) {
        console.error('weekly-review: legacy mirror не записано', error?.message);
      }
      return true;
    });
  }
  /** @param {string|null|undefined} token */ async release(token) {
    return this.#serial(async () => {
      const lease = /** @type {{token?: string}|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (!token || lease?.token !== token) return false;
      await this.ctx.storage.delete(LEASE_KEY);
      return true;
    });
  }
}
