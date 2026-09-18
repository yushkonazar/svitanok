import { DurableObject } from 'cloudflare:workers';
import {
  normalizeSteamCheckState,
  STEAM_MARKER_KEY,
  STEAM_MISS_KEY,
  STEAM_SALE_KEY,
} from './contract.mjs';

const STATE_KEY = 'state';
const LEASE_KEY = 'lease';

export class SteamCheckStateDO extends DurableObject {
  #ops = Promise.resolve();

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  #serial(work) {
    const next = this.#ops.then(work, work);
    this.#ops = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** @param {unknown} legacy */
  async #read(legacy) {
    const stored = await this.ctx.storage.get(STATE_KEY);
    if (stored !== undefined) return normalizeSteamCheckState(stored);
    const state = normalizeSteamCheckState(legacy);
    await this.ctx.storage.put(STATE_KEY, state);
    return state;
  }

  /** @param {unknown} legacy @param {string} today @param {number} nowMs @param {number} leaseMs */
  async claim(legacy, today, nowMs, leaseMs) {
    return this.#serial(async () => {
      const state = await this.#read(legacy);
      if (state.completedDay === today) return { ok: false, reason: 'done' };
      const lease = /** @type {{token?: string, untilMs?: number}|undefined} */ (
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

  /** @param {string|null|undefined} token @param {unknown} next */
  async complete(token, next) {
    return this.#serial(async () => {
      const lease = /** @type {{token?: string}|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (!token || lease?.token !== token) return false;
      const state = normalizeSteamCheckState(next);
      await this.ctx.storage.put(STATE_KEY, state);
      await this.ctx.storage.delete(LEASE_KEY);
      try {
        await this.env.BRIEFING?.put?.(STEAM_MARKER_KEY, state.completedDay);
        await this.env.BRIEFING?.put?.(STEAM_MISS_KEY, String(state.misses));
        await this.env.BRIEFING?.put?.(STEAM_SALE_KEY, String(state.saleShare));
      } catch (/** @type {any} */ error) {
        console.error('steam-check-state: legacy mirror не записано', error?.message);
      }
      return true;
    });
  }

  /** @param {string|null|undefined} token */
  async release(token) {
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
