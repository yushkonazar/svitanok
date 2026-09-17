// Durable Object для structured legacy-blob'ів `state`, `stats` і `settings`.
//
// KV не має CAS і може повертати кешовану копію після чужого запису. Тут
// зберігається authoritative value + version у SQLite-backed DO; Worker
// застосовує локальний pure patch через compare-and-set і, за конфлікту,
// повторює patch на свіжому snapshot. KV лишається лише сумісною проєкцією
// для старого ранкового briefing-а та legacy backup, а не source of truth.

import { DurableObject } from 'cloudflare:workers';
import { MUTABLE_STATE_KEYS } from './contract.mjs';

/** @typedef {{ version: number, value: Record<string, unknown> }} MutableRecord */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asBlob(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

export class StateStoreDO extends DurableObject {
  /**
   * Явна serial queue, а не припущення про input gates. Вона потрібна і
   * production DO (де `await` зовнішнього KV I/O може відкрити input gate),
   * і детерміністичним Node-тестам зі звичайним Map storage.
   * @type {Promise<void>}
   */
  #operations = Promise.resolve();

  /**
   * KV I/O може відкрити input gate DO. Ланцюжок гарантує, що compatibility
   * snapshots підуть у version order навіть тоді, коли наступний CAS уже
   * встиг записати canonical SQLite state.
   * @type {Map<'state'|'stats'|'settings', Promise<void>>}
   */
  #legacyMirrors = new Map();

  /** @param {string} key */
  #assertKey(key) {
    if (!MUTABLE_STATE_KEYS.includes(/** @type {'state'|'stats'|'settings'} */ (key))) {
      throw new Error(`state-store: невідомий ключ ${key}`);
    }
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  #serial(operation) {
    const next = this.#operations.then(operation, operation);
    this.#operations = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Прочитати canonical snapshot. Перший виклик одноразово сіє DO значенням
   * старого KV-ключа; усі наступні ігнорують legacy snapshot, тому застарілий
   * KV read більше не може повернути state назад у часі.
   * @param {'state'|'stats'|'settings'} key
   * @param {unknown} legacyValue
   * @returns {Promise<MutableRecord>}
   */
  async read(key, legacyValue) {
    return this.#serial(() => this.#read(key, legacyValue));
  }

  /** @param {'state'|'stats'|'settings'} key @param {unknown} legacyValue
   * @returns {Promise<MutableRecord>} */
  async #read(key, legacyValue) {
    this.#assertKey(key);
    const existing = /** @type {MutableRecord | undefined} */ (await this.ctx.storage.get(key));
    if (existing && Number.isInteger(existing.version) && existing.version >= 0) {
      return { version: existing.version, value: asBlob(existing.value) };
    }
    const created = { version: 0, value: asBlob(legacyValue) };
    await this.ctx.storage.put(key, created);
    return created;
  }

  /**
   * Атомарний CAS усередині одного DO. Коли версія не збігається, повертаємо
   * поточний snapshot — викликач повторно застосує ТУ САМУ чисту мутацію без
   * втрати паралельної зміни.
   * @param {'state'|'stats'|'settings'} key
   * @param {number} expectedVersion
   * @param {unknown} nextValue
   * @returns {Promise<{ ok: true, record: MutableRecord } | { ok: false, record: MutableRecord }>}
   */
  async compareAndSet(key, expectedVersion, nextValue) {
    return this.#serial(async () => {
      const current = await this.#read(key, {});
      if (current.version !== expectedVersion) return { ok: false, record: current };
      const record = { version: current.version + 1, value: asBlob(nextValue) };
      await this.ctx.storage.put(key, record);
      // Двійкове legacy-віддзеркалення не є частиною commit: недоступний KV не
      // може скасувати вже прийняту canonical зміну. Воно упорядковане через
      // singleton DO (кожен CAS завершує put перед відповіддю), тому старий
      // briefing не отримає версію N після N+1.
      await this.#mirrorLegacy(key, record.value);
      return { ok: true, record };
    });
  }

  /** Очистити canonical slot без compatibility mirror. Це потрібно T2: KV
   * видаляється окремо й не має воскреснути дефолтним snapshot-ом.
   * @param {'state'|'stats'|'settings'} key */
  async clear(key) {
    return this.#serial(async () => {
      this.#assertKey(key);
      const existing = /** @type {MutableRecord | undefined} */ (await this.ctx.storage.get(key));
      const version =
        existing && Number.isInteger(existing.version) && existing.version >= 0
          ? existing.version + 1
          : 0;
      const record = { version, value: {} };
      await this.ctx.storage.put(key, record);
      return record;
    });
  }

  /** @param {'state'|'stats'|'settings'} key @param {Record<string, unknown>} value */
  async #mirrorLegacy(key, value) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    const previous = this.#legacyMirrors.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        try {
          await kv.put(key, JSON.stringify(value));
        } catch (/** @type {any} */ error) {
          // Source of truth уже у DO. Сумісний snapshot надолужить наступна
          // mutation/backup; падати й втрачати щойно прийняту зміну гірше.
          console.error(`state-store: legacy mirror ${key} не записано`, error?.message);
        }
      });
    this.#legacyMirrors.set(key, next);
    await next;
  }
}
