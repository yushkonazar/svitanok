// Canonical коротка history асистента. KV не має CAS, тому одночасні питання
// callback-а й фініш agent run могли перетерти репліки одне одного. DO додає
// turn batches serially; KV лишається TTL mirror для rollback і старого export.

import { DurableObject } from 'cloudflare:workers';
import { appendTurn } from '../../assistant-memory-core.mjs';
import { ASSISTANT_HISTORY_KEY } from './contract.mjs';

const RECORD_KEY = 'history';
const HISTORY_TTL_MS = 30 * 86_400_000;

/** @typedef {{ version: number, history: Record<string, unknown>, expiresAt: number }} HistoryRecord */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asBlob(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

export class AssistantHistoryDO extends DurableObject {
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

  /** @param {unknown} legacyValue @param {number} nowMs
   * @returns {Promise<HistoryRecord>} */
  async read(legacyValue, nowMs = Date.now()) {
    return this.#serial(() => this.#read(legacyValue, nowMs));
  }

  /** @param {unknown} legacyValue @param {number} nowMs
   * @returns {Promise<HistoryRecord>} */
  async #read(legacyValue, nowMs) {
    const existing = /** @type {HistoryRecord | undefined} */ (
      await this.ctx.storage.get(RECORD_KEY)
    );
    if (existing && Number.isInteger(existing.version) && existing.version >= 0) {
      if (Number.isFinite(existing.expiresAt) && existing.expiresAt > nowMs) {
        return {
          version: existing.version,
          history: asBlob(existing.history),
          expiresAt: existing.expiresAt,
        };
      }
      const expired = { version: existing.version + 1, history: {}, expiresAt: 0 };
      await this.ctx.storage.put(RECORD_KEY, expired);
      return expired;
    }
    const created = { version: 0, history: asBlob(legacyValue), expiresAt: nowMs + HISTORY_TTL_MS };
    await this.ctx.storage.put(RECORD_KEY, created);
    await this.ctx.storage.setAlarm(created.expiresAt);
    return created;
  }

  /** Додати впорядковану пачку turn-ів до одного chat/thread. Пачка exchange
   * (user → assistant) є одним DO-рішенням, тому паралельне питання не може
   * опинитися між її половинами.
   * @param {unknown} legacyValue
   * @param {string|number|null|undefined} chatId
   * @param {string|number|null|undefined} threadId
   * @param {{ role: string, text: string }[]} turns
   * @param {number} nowMs
   * @returns {Promise<HistoryRecord>}
   */
  async append(legacyValue, chatId, threadId, turns, nowMs = Date.now()) {
    return this.#serial(async () => {
      const current = await this.#read(legacyValue, nowMs);
      let history = current.history;
      for (const turn of turns) {
        history = appendTurn(history, chatId, threadId, turn?.role, turn?.text);
      }
      const record = {
        version: current.version + 1,
        history,
        expiresAt: nowMs + HISTORY_TTL_MS,
      };
      await this.ctx.storage.put(RECORD_KEY, record);
      await this.ctx.storage.setAlarm(record.expiresAt);
      await this.#mirror(record.history);
      return record;
    });
  }

  /** Compatibility-only full replacement for rollback/local tests. */
  async replace(/** @type {unknown} */ history, nowMs = Date.now()) {
    return this.#serial(async () => {
      const current = await this.#read(null, nowMs);
      const record = {
        version: current.version + 1,
        history: asBlob(history),
        expiresAt: nowMs + HISTORY_TTL_MS,
      };
      await this.ctx.storage.put(RECORD_KEY, record);
      await this.ctx.storage.setAlarm(record.expiresAt);
      await this.#mirror(record.history);
      return record;
    });
  }

  /** T2 canonical cleanup; KV mirror is deleted by FORGET_ALL_KV_KEYS. */
  async clear() {
    return this.#serial(async () => {
      const current = await this.#read(null, Date.now());
      const record = { version: current.version + 1, history: {}, expiresAt: 0 };
      await this.ctx.storage.put(RECORD_KEY, record);
      return { cleared: Object.keys(current.history).length > 0 };
    });
  }

  /** TTL cleanup happens even if no Worker reads this history again.
   * @override */
  async alarm() {
    return this.#serial(async () => {
      const current = /** @type {HistoryRecord | undefined} */ (
        await this.ctx.storage.get(RECORD_KEY)
      );
      if (!current || !Number.isFinite(current.expiresAt) || current.expiresAt <= 0) return;
      const nowMs = Date.now();
      if (current.expiresAt > nowMs) {
        await this.ctx.storage.setAlarm(current.expiresAt);
        return;
      }
      // Tombstone, not delete: an eventually expired legacy KV mirror must
      // never seed an already expired canonical history on the next read.
      await this.ctx.storage.put(RECORD_KEY, {
        version: Number.isInteger(current.version) ? current.version + 1 : 0,
        history: {},
        expiresAt: 0,
      });
    });
  }

  /** @param {Record<string, unknown>} history */
  async #mirror(history) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(ASSISTANT_HISTORY_KEY, JSON.stringify(history), {
        expirationTtl: Math.floor(HISTORY_TTL_MS / 1000),
      });
    } catch (/** @type {any} */ error) {
      console.error('assistant-history: legacy mirror не записано', error?.message);
    }
  }
}
