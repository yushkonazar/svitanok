// Durable Object єдиного pending-proposal slot. KV не має CAS, тому два
// одночасні callback-и могли обидва списати ту саму пропозицію і повторити
// зовнішню дію. Тут serializable storage тримає value+version; legacy KV є
// лише одноразовим seed і compatibility mirror для rollback.

import { DurableObject } from 'cloudflare:workers';
import { ASSISTANT_PENDING_KEY } from './contract.mjs';

const PENDING_KEY = 'pending';

/** @typedef {{ version: number, value: Record<string, unknown> | null }} PendingRecord */

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asPending(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

export class PendingProposalsDO extends DurableObject {
  /** Явна черга лишається правильною і для Node-тестів зі звичайним Map, і
   * коли await compatibility-KV відкриває input gate production DO. */
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

  /** @param {unknown} legacyValue @returns {Promise<PendingRecord>} */
  async read(legacyValue) {
    return this.#serial(() => this.#read(legacyValue));
  }

  /** @param {unknown} legacyValue @returns {Promise<PendingRecord>} */
  async #read(legacyValue) {
    const existing = /** @type {PendingRecord | undefined} */ (
      await this.ctx.storage.get(PENDING_KEY)
    );
    if (existing && Number.isInteger(existing.version) && existing.version >= 0) {
      return { version: existing.version, value: asPending(existing.value) };
    }
    const created = { version: 0, value: asPending(legacyValue) };
    await this.ctx.storage.put(PENDING_KEY, created);
    return created;
  }

  /** Новий pending slot. Перезапис — свідома UX-семантика одного слоту, не
   * CAS-конфлікт; id кнопки не дає старій пропозиції виконатись після цього.
   * @param {unknown} value @returns {Promise<PendingRecord>} */
  async replace(value) {
    return this.#serial(async () => {
      const current = await this.#read(null);
      const next = { version: current.version + 1, value: asPending(value) };
      await this.ctx.storage.put(PENDING_KEY, next);
      await this.#mirror(next.value);
      return next;
    });
  }

  /** CAS для UI-циклерів. Клієнт повторно застосовує чистий patch до
   * найсвіжішої версії; так два швидкі тапи не гублять перший зсув/тривалість.
   * @param {number} expectedVersion
   * @param {unknown} value
   * @returns {Promise<{ ok: true, record: PendingRecord } | { ok: false, record: PendingRecord }>}
   */
  async compareAndSet(expectedVersion, value) {
    return this.#serial(async () => {
      const current = await this.#read(null);
      if (current.version !== expectedVersion) return { ok: false, record: current };
      const record = { version: current.version + 1, value: asPending(value) };
      await this.ctx.storage.put(PENDING_KEY, record);
      await this.#mirror(record.value);
      return { ok: true, record };
    });
  }

  /** Атомарне списання. Лише рівно один callback із цим id дістане true. */
  async claim(/** @type {string} */ id) {
    return this.#serial(async () => {
      const current = await this.#read(null);
      if (current.value?.id !== id) return false;
      const record = { version: current.version + 1, value: null };
      await this.ctx.storage.put(PENDING_KEY, record);
      await this.#mirror(null);
      return true;
    });
  }

  /** T2 `forget all`: прибирає canonical copy, а KV mirror чистить окремий
   * workflow (той же список FORGET_ALL_KV_KEYS). */
  async clear() {
    return this.#serial(async () => {
      const current = await this.#read(null);
      const record = { version: current.version + 1, value: null };
      await this.ctx.storage.put(PENDING_KEY, record);
      return { cleared: current.value !== null };
    });
  }

  /** @param {Record<string, unknown> | null} value */
  async #mirror(value) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      // Tombstone, not delete: legacy KV has no read-your-writes.
      await kv.put(ASSISTANT_PENDING_KEY, JSON.stringify(value));
    } catch (/** @type {any} */ error) {
      // Canonical commit already succeeded. A later mutation or rollback seed
      // repairs the mirror; rejecting would only make owner callback lie.
      console.error('pending-proposals: legacy mirror не записано', error?.message);
    }
  }
}
