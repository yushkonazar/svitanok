// Canonical single-consumer continuation slots. A KV get/delete pair allowed
// two simultaneous owner messages to consume the same agent note and launch
// two equivalent runs. This singleton serializes take/save per slot.

import { DurableObject } from 'cloudflare:workers';
import { ASSISTANT_RESUME_TTL_MS, assistantResumeLegacyKey } from './contract.mjs';

const STATE_KEY = 'resumes';

/** @typedef {{ note: string, tainted: boolean, atMs: number }} Resume */
/** @typedef {{ version: number, values: Record<string, Resume|null>, legacySeedEnabled: boolean }} ResumeState */

/** @param {unknown} value @param {number} nowMs @returns {Resume|null} */
function asResume(value, nowMs) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  const atMs = Number.isFinite(raw.atMs) ? Number(raw.atMs) : 0;
  if (!note || !atMs || atMs + ASSISTANT_RESUME_TTL_MS <= nowMs) return null;
  return { note, tainted: raw.tainted === true, atMs };
}

/** @param {unknown} value @returns {ResumeState|null} */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  if (!Number.isInteger(raw.version) || Number(raw.version) < 0) return null;
  const rawValues = /** @type {Record<string, unknown>} */ (
    raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? raw.values : {}
  );
  /** @type {Record<string, Resume|null>} */
  const values = {};
  for (const [slot, resume] of Object.entries(rawValues)) {
    values[slot] =
      resume && typeof resume === 'object' && !Array.isArray(resume)
        ? /** @type {Resume} */ (resume)
        : null;
  }
  return {
    version: Number(raw.version),
    values,
    legacySeedEnabled: raw.legacySeedEnabled !== false,
  };
}

export class AssistantResumeDO extends DurableObject {
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

  /** @param {number} nowMs @returns {Promise<ResumeState>} */
  async #read(nowMs) {
    const stored = asState(await this.ctx.storage.get(STATE_KEY));
    if (!stored) {
      const created = { version: 0, values: {}, legacySeedEnabled: true };
      await this.ctx.storage.put(STATE_KEY, created);
      return created;
    }
    /** @type {string[]} */
    const expired = [];
    const values = { ...stored.values };
    for (const [slot, resume] of Object.entries(values)) {
      if (resume && !asResume(resume, nowMs)) {
        values[slot] = null;
        expired.push(slot);
      }
    }
    if (!expired.length) return stored;
    const next = { ...stored, version: stored.version + 1, values };
    await this.ctx.storage.put(STATE_KEY, next);
    await Promise.all(expired.map((slot) => this.#deleteMirror(slot)));
    return next;
  }

  /** @param {ResumeState} state @param {number} nowMs */
  async #schedule(state, nowMs) {
    const expiresAt = Math.min(
      ...Object.values(state.values)
        .filter((resume) => resume && resume.atMs + ASSISTANT_RESUME_TTL_MS > nowMs)
        .map((resume) => /** @type {Resume} */ (resume).atMs + ASSISTANT_RESUME_TTL_MS),
    );
    if (Number.isFinite(expiresAt)) await this.ctx.storage.setAlarm(expiresAt);
  }

  /** Save/replace the one continuation note for this chat/thread.
   * @param {string} slot @param {unknown} value @param {number} [nowMs] */
  async save(slot, value, nowMs = Date.now()) {
    return this.#serial(async () => {
      const current = await this.#read(nowMs);
      const resume = asResume(value, nowMs);
      if (!resume) return false;
      const next = {
        ...current,
        version: current.version + 1,
        values: { ...current.values, [slot]: resume },
      };
      await this.ctx.storage.put(STATE_KEY, next);
      await this.#schedule(next, nowMs);
      await this.#mirror(slot, resume);
      return true;
    });
  }

  /** Atomically consume a continuation note once. A KV value may seed only an
   * untouched slot; tombstones block its stale resurrection after consumption.
   * @param {string} slot @param {unknown} legacyValue @param {number} [nowMs]
   * @returns {Promise<Resume|null>} */
  async take(slot, legacyValue, nowMs = Date.now()) {
    return this.#serial(async () => {
      const current = await this.#read(nowMs);
      const known = Object.hasOwn(current.values, slot);
      const resume = known
        ? asResume(current.values[slot], nowMs)
        : current.legacySeedEnabled
          ? asResume(legacyValue, nowMs)
          : null;
      if (!resume) {
        // An expired/malformed legacy mirror is not useful and should not be
        // retried on every next message. No empty tombstone for never-used
        // slots: ordinary cold starts must not grow the singleton forever.
        if (!known && legacyValue != null) await this.#deleteMirror(slot);
        return null;
      }
      const next = {
        ...current,
        version: current.version + 1,
        values: { ...current.values, [slot]: null },
      };
      await this.ctx.storage.put(STATE_KEY, next);
      await this.#deleteMirror(slot);
      return resume;
    });
  }

  /** T2 privacy cleanup. Disables legacy seeding so a delayed KV mirror can
   * never restore erased assistant context. */
  async clear() {
    return this.#serial(async () => {
      const current = await this.#read(Date.now());
      const cleared = Object.values(current.values).some(Boolean);
      await this.ctx.storage.put(STATE_KEY, {
        version: current.version + 1,
        values: {},
        legacySeedEnabled: false,
      });
      // Dynamic KV keys cannot be covered by the static T2 key list. Every
      // slot ever known to this canonical record is deleted explicitly; the
      // remaining seed guard covers a stale pre-migration mirror until its TTL.
      await Promise.all(Object.keys(current.values).map((slot) => this.#deleteMirror(slot)));
      return { cleared };
    });
  }

  /** Expire unattended slots even while the Worker is idle. @override */
  async alarm() {
    return this.#serial(async () => {
      const current = await this.#read(Date.now());
      await this.#schedule(current, Date.now());
    });
  }

  /** @param {string} slot @param {Resume} resume */
  async #mirror(slot, resume) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(assistantResumeLegacyKey(slot), JSON.stringify(resume), {
        expirationTtl: Math.ceil(ASSISTANT_RESUME_TTL_MS / 1000),
      });
    } catch (/** @type {any} */ error) {
      console.error('assistant-resume: legacy mirror не записано', error?.message);
    }
  }

  /** @param {string} slot */
  async #deleteMirror(slot) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.delete !== 'function') return;
    try {
      await kv.delete(assistantResumeLegacyKey(slot));
    } catch (/** @type {any} */ error) {
      console.error('assistant-resume: legacy mirror не видалено', error?.message);
    }
  }
}
