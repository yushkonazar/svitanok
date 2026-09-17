// Durable Object для atomic ring-buffer-а повідомлень /clear. KV не має CAS:
// два паралельні send/cron/outbox виклики могли кожен записати власний знімок
// і загубити id іншого. Canonical record тут, KV — лише mirror для rollback.

import { DurableObject } from 'cloudflare:workers';
import { recordSentMessage, sentMessagesKey, trackedMessages } from '../../tg-core.mjs';
import { SENT_MESSAGES_KEY } from './contract.mjs';

const RECORD_KEY = 'messages';

/** @typedef {{ version: number, value: Record<string, unknown> }} SentMessagesRecord */

/** @param {unknown} value @returns {Record<string, unknown>} */
function asBlob(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

export class SentMessagesDO extends DurableObject {
  // Explicit queue is needed in Node tests and remains correct if awaiting the
  // compatibility KV mirror opens a production Durable Object input gate.
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

  /** @param {unknown} legacyValue @returns {Promise<SentMessagesRecord>} */
  async read(legacyValue) {
    return this.#serial(() => this.#read(legacyValue));
  }

  /** @param {unknown} legacyValue @returns {Promise<SentMessagesRecord>} */
  async #read(legacyValue) {
    const existing = /** @type {SentMessagesRecord | undefined} */ (
      await this.ctx.storage.get(RECORD_KEY)
    );
    if (existing && Number.isInteger(existing.version) && existing.version >= 0) {
      return { version: existing.version, value: asBlob(existing.value) };
    }
    const created = { version: 0, value: asBlob(legacyValue) };
    await this.ctx.storage.put(RECORD_KEY, created);
    return created;
  }

  /** Додати id у потрібний chat/thread ring buffer атомарно.
   * @param {unknown} legacyValue
   * @param {string|number|null|undefined} chatId
   * @param {string|number|null|undefined} threadId
   * @param {number} messageId
   * @param {boolean} [own]
   * @returns {Promise<SentMessagesRecord>}
   */
  async record(legacyValue, chatId, threadId, messageId, own = false) {
    return this.#serial(async () => {
      const current = await this.#read(legacyValue);
      const record = {
        version: current.version + 1,
        value: recordSentMessage(current.value, chatId, threadId, messageId, own),
      };
      await this.ctx.storage.put(RECORD_KEY, record);
      await this.#mirror(record.value);
      return record;
    });
  }

  /** Прибрати лише точно названі id після результатів deleteMessage; будь-які
   * паралельно додані id у цьому самому чаті лишаються у свіжому record.
   * @param {unknown} legacyValue
   * @param {string|number|null|undefined} chatId
   * @param {string|number|null|undefined} threadId
   * @param {number[]} ids
   * @returns {Promise<SentMessagesRecord>}
   */
  async forget(legacyValue, chatId, threadId, ids) {
    return this.#serial(async () => {
      const current = await this.#read(legacyValue);
      const forgotten = new Set(ids);
      const key = sentMessagesKey(chatId, threadId);
      const value = {
        ...current.value,
        [key]: trackedMessages(current.value[key]).filter((entry) => !forgotten.has(entry.id)),
      };
      const record = { version: current.version + 1, value };
      await this.ctx.storage.put(RECORD_KEY, record);
      await this.#mirror(record.value);
      return record;
    });
  }

  /** Compatibility-only full replacement. Production callers must use
   * record/forget so their mutation is applied inside this singleton.
   * @param {unknown} value */
  async replace(value) {
    return this.#serial(async () => {
      const current = await this.#read(null);
      const record = { version: current.version + 1, value: asBlob(value) };
      await this.ctx.storage.put(RECORD_KEY, record);
      await this.#mirror(record.value);
      return record;
    });
  }

  /** T2 cleanup. KV mirror is deleted by FORGET_ALL_KV_KEYS afterwards. */
  async clear() {
    return this.#serial(async () => {
      const current = await this.#read(null);
      const record = { version: current.version + 1, value: {} };
      await this.ctx.storage.put(RECORD_KEY, record);
      return { cleared: Object.keys(current.value).length > 0 };
    });
  }

  /** @param {Record<string, unknown>} value */
  async #mirror(value) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(SENT_MESSAGES_KEY, JSON.stringify(value));
    } catch (/** @type {any} */ error) {
      // Canonical change already committed. A later mutation repairs the
      // compatibility mirror; failing the message delivery would be worse.
      console.error('sent-messages: legacy mirror не записано', error?.message);
    }
  }
}
