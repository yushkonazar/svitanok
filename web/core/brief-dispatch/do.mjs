// Atomic dispatch lease for manual /brief and the five-minute auto scheduler.
// The legacy KV marker is a compatibility mirror only; a check-then-dispatch
// sequence against KV could start the external GitHub workflow twice.

import { DurableObject } from 'cloudflare:workers';
import { BRIEF_DISPATCH_KEY } from './contract.mjs';

const STATE_KEY = 'dispatch';
// Dispatch до GitHub зазвичай відповідає одразу. Десять хвилин лишають запас
// на мережевий хвіст, але не дозволяють наступному п'ятихвилинному cron-tick
// почати другий зовнішній workflow, поки перший ще невідомо завершується.
const LEASE_MS = 10 * 60_000;

/** @typedef {{ lastMs: number|null, lastAutoDate: string|null, pending: { token: string, until: number }|null }} DispatchState */

/** @param {unknown} value @returns {DispatchState} */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  const lastMs = Number.isFinite(raw.lastMs) ? Number(raw.lastMs) : null;
  const pendingRaw =
    raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending)
      ? /** @type {Record<string, unknown>} */ (raw.pending)
      : null;
  const pending =
    pendingRaw && typeof pendingRaw.token === 'string' && Number.isFinite(pendingRaw.until)
      ? { token: pendingRaw.token, until: Number(pendingRaw.until) }
      : null;
  return {
    lastMs: lastMs && lastMs > 0 ? lastMs : null,
    lastAutoDate:
      typeof raw.lastAutoDate === 'string' && raw.lastAutoDate ? raw.lastAutoDate : null,
    pending,
  };
}

export class BriefDispatchDO extends DurableObject {
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

  /** @param {unknown} legacyValue @returns {Promise<DispatchState>} */
  async read(legacyValue) {
    return this.#serial(() => this.#read(legacyValue));
  }

  /** @param {unknown} legacyValue @returns {Promise<DispatchState>} */
  async #read(legacyValue) {
    const existing = await this.ctx.storage.get(STATE_KEY);
    if (existing) return asState(existing);
    const state = asState(legacyValue);
    await this.ctx.storage.put(STATE_KEY, state);
    return state;
  }

  /** Claim an external dispatch before invoking GitHub.
   * @param {unknown} legacyValue @param {number} nowMs
   * @param {string|null} autoDate @param {number} minGapMs */
  async claim(legacyValue, nowMs, autoDate, minGapMs) {
    return this.#serial(async () => {
      const state = await this.#read(legacyValue);
      if (Number(state.pending?.until ?? 0) > nowMs) return { ok: false, reason: 'pending' };
      if (state.lastMs && nowMs - state.lastMs < minGapMs) return { ok: false, reason: 'cooldown' };
      if (autoDate && state.lastAutoDate === autoDate) return { ok: false, reason: 'auto-done' };
      const token = crypto.randomUUID();
      const next = { ...state, pending: { token, until: nowMs + LEASE_MS } };
      await this.ctx.storage.put(STATE_KEY, next);
      return { ok: true, token };
    });
  }

  /** Persist only an acknowledged GitHub dispatch; failed attempts release. */
  async complete(/** @type {string} */ token, /** @type {number} */ nowMs, autoDate = null) {
    return this.#serial(async () => {
      const state = asState(await this.ctx.storage.get(STATE_KEY));
      if (state.pending?.token !== token) return false;
      const next = {
        lastMs: nowMs,
        lastAutoDate: autoDate ?? state.lastAutoDate,
        pending: null,
      };
      await this.ctx.storage.put(STATE_KEY, next);
      await this.#mirror(next);
      return true;
    });
  }

  async release(/** @type {string} */ token) {
    return this.#serial(async () => {
      const state = asState(await this.ctx.storage.get(STATE_KEY));
      if (state.pending?.token !== token) return false;
      await this.ctx.storage.put(STATE_KEY, { ...state, pending: null });
      return true;
    });
  }

  /** @param {DispatchState} state */
  async #mirror(state) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(
        BRIEF_DISPATCH_KEY,
        JSON.stringify({ lastMs: state.lastMs, lastAutoDate: state.lastAutoDate }),
      );
    } catch (/** @type {any} */ error) {
      console.error('brief-dispatch: legacy mirror не записано', error?.message);
    }
  }
}
