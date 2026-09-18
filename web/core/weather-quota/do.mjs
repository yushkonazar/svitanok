import { DurableObject } from 'cloudflare:workers';
import { WEATHER_LIVE_COUNTER_KEY } from './contract.mjs';

const STATE_KEY = 'quota';

/** @typedef {{ date: string|null, count: number }} WeatherQuotaState */

/** @param {unknown} value @returns {WeatherQuotaState} */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  return {
    date: typeof raw.date === 'string' && raw.date ? raw.date : null,
    count: Number.isInteger(raw.count) && Number(raw.count) >= 0 ? Number(raw.count) : 0,
  };
}

export class WeatherQuotaDO extends DurableObject {
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

  /** @param {unknown} legacyValue @returns {Promise<WeatherQuotaState>} */
  async #read(legacyValue) {
    const existing = await this.ctx.storage.get(STATE_KEY);
    if (existing) return asState(existing);
    const seeded = asState(legacyValue);
    await this.ctx.storage.put(STATE_KEY, seeded);
    return seeded;
  }

  /** Reserve all calls before contacting OpenWeather. If the entire amount
   * does not fit, no partial request is made and concurrent cache misses cannot
   * exceed the shared daily budget.
   * @param {unknown} legacyValue @param {string} date @param {number} amount @param {number} limit */
  async consume(legacyValue, date, amount, limit) {
    return this.#serial(async () => {
      const current = await this.#read(legacyValue);
      const base = current.date === date ? current : { date, count: 0 };
      const safeAmount = Number.isInteger(amount) && amount > 0 ? amount : 0;
      const safeLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;
      if (!safeAmount || base.count + safeAmount > safeLimit) {
        return { ok: false, count: base.count, remaining: Math.max(0, safeLimit - base.count) };
      }
      const next = { date, count: base.count + safeAmount };
      await this.ctx.storage.put(STATE_KEY, next);
      await this.#mirror(next);
      return { ok: true, count: next.count, remaining: safeLimit - next.count };
    });
  }

  /** T2 clean-up. Tombstone avoids reseeding the cleared canonical quota from
   * an eventually stale KV compatibility mirror. */
  async clear() {
    return this.#serial(async () => {
      const current = asState(await this.ctx.storage.get(STATE_KEY));
      await this.ctx.storage.put(STATE_KEY, { date: null, count: 0 });
      return { cleared: Boolean(current.date || current.count) };
    });
  }

  /** @param {WeatherQuotaState} state */
  async #mirror(state) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(WEATHER_LIVE_COUNTER_KEY, JSON.stringify(state));
    } catch (/** @type {any} */ error) {
      console.error('weather-quota: legacy mirror не записано', error?.message);
    }
  }
}
