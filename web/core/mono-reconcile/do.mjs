import { DurableObject } from 'cloudflare:workers';
import { MONO_RECONCILE_KEY } from './contract.mjs';

const STATE_KEY = 'state';
const LEASE_KEY = 'lease';

export class MonoReconcileDO extends DurableObject {
  #operations = Promise.resolve();

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #serial(operation) {
    const next = this.#operations.then(operation, operation);
    this.#operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** @param {unknown} legacyValue */
  async #read(legacyValue) {
    const existing = await this.ctx.storage.get(STATE_KEY);
    if (existing !== undefined) return existing;
    const seeded = legacyValue ?? null;
    await this.ctx.storage.put(STATE_KEY, seeded);
    return seeded;
  }

  /** @param {unknown} legacyValue */
  async read(legacyValue) {
    return this.#serial(() => this.#read(legacyValue));
  }

  /** @param {unknown} legacyValue @param {number} nowMs @param {number} leaseMs */
  async claim(legacyValue, nowMs, leaseMs) {
    return this.#serial(async () => {
      const state = await this.#read(legacyValue);
      const current = /** @type {{ token?: string, untilMs?: number }|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (current?.token && Number(current.untilMs) > nowMs) return { ok: false, reason: 'busy' };
      const token = crypto.randomUUID();
      await this.ctx.storage.put(LEASE_KEY, {
        token,
        untilMs: nowMs + Math.max(1, Number(leaseMs) || 0),
      });
      return { ok: true, token, state };
    });
  }

  /** @param {string|null|undefined} token @param {unknown} state */
  async complete(token, state) {
    return this.#serial(async () => {
      const lease = /** @type {{ token?: string }|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (!token || lease?.token !== token) return false;
      await this.ctx.storage.put(STATE_KEY, state ?? null);
      await this.ctx.storage.delete(LEASE_KEY);
      await this.#mirror(state ?? null);
      return true;
    });
  }

  /** @param {string|null|undefined} token */
  async release(token) {
    return this.#serial(async () => {
      const lease = /** @type {{ token?: string }|undefined} */ (
        await this.ctx.storage.get(LEASE_KEY)
      );
      if (!token || lease?.token !== token) return false;
      await this.ctx.storage.delete(LEASE_KEY);
      return true;
    });
  }

  /** @param {unknown} state */
  async #mirror(state) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(MONO_RECONCILE_KEY, JSON.stringify(state));
    } catch (/** @type {any} */ error) {
      console.error('mono-reconcile: legacy mirror не записано', error?.message);
    }
  }
}
