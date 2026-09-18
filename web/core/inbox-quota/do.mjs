import { DurableObject } from 'cloudflare:workers';
import { INBOX_COUNT_KEY } from './contract.mjs';

const STATE_KEY = 'quota';

/** @typedef {{ date: string|null, n: number, alerted: boolean }} InboxQuotaState */

/** @param {unknown} value @returns {InboxQuotaState} */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  return {
    date: typeof raw.date === 'string' && raw.date ? raw.date : null,
    n: Number.isInteger(raw.n) && Number(raw.n) >= 0 ? Number(raw.n) : 0,
    alerted: raw.alerted === true,
  };
}

export class InboxQuotaDO extends DurableObject {
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

  /** @param {unknown} legacyValue @returns {Promise<InboxQuotaState>} */
  async #read(legacyValue) {
    const existing = await this.ctx.storage.get(STATE_KEY);
    if (existing) return asState(existing);
    const seeded = asState(legacyValue);
    await this.ctx.storage.put(STATE_KEY, seeded);
    return seeded;
  }

  /**
   * Reserve one D1 inbox row before the insert. `alert` belongs to precisely
   * one denied reservation, so a cap cannot turn concurrent webhooks into a
   * burst of owner alerts.
   * @param {unknown} legacyValue @param {string} date @param {number} limit
   */
  async take(legacyValue, date, limit) {
    return this.#serial(async () => {
      const current = await this.#read(legacyValue);
      const base = current.date === date ? current : { date, n: 0, alerted: false };
      const safeLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;
      if (base.n >= safeLimit) {
        const next = base.alerted ? base : { ...base, alerted: true };
        if (!base.alerted) {
          await this.ctx.storage.put(STATE_KEY, next);
          await this.#mirror(next);
        }
        return { allowed: false, alert: !base.alerted, n: base.n };
      }
      const next = { ...base, n: base.n + 1 };
      await this.ctx.storage.put(STATE_KEY, next);
      await this.#mirror(next);
      return { allowed: true, alert: false, n: next.n };
    });
  }

  /** T2 clean-up. Tombstone prevents an old compatibility mirror becoming a
   * fresh canonical counter after personal data has been erased. */
  async clear() {
    return this.#serial(async () => {
      const current = asState(await this.ctx.storage.get(STATE_KEY));
      await this.ctx.storage.put(STATE_KEY, { date: null, n: 0, alerted: false });
      return { cleared: Boolean(current.date || current.n || current.alerted) };
    });
  }

  /** @param {InboxQuotaState} state */
  async #mirror(state) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(INBOX_COUNT_KEY, JSON.stringify(state));
    } catch (/** @type {any} */ error) {
      console.error('inbox-quota: legacy mirror не записано', error?.message);
    }
  }
}
