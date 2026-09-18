import { DurableObject } from 'cloudflare:workers';
import { hostHealthTransition } from '../../agent-core.mjs';
import { AGENT_HOST_HEALTH_KEY } from './contract.mjs';

const STATE_KEY = 'health';

/** @typedef {{ state: 'ok'|'desync', atMs: number }} AgentHostHealthState */

/** @param {unknown} value @returns {AgentHostHealthState} */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  return {
    state: raw.state === 'desync' ? 'desync' : 'ok',
    atMs: Number.isFinite(raw.atMs) ? Number(raw.atMs) : 0,
  };
}

export class AgentHostHealthDO extends DurableObject {
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
    if (existing) return asState(existing);
    const seeded = asState(legacyValue);
    await this.ctx.storage.put(STATE_KEY, seeded);
    return seeded;
  }

  /** Atomically derive the alert from the last accepted probe state.
   * @param {unknown} legacyValue @param {'ok'|'desync'|'unknown'} current @param {number} atMs */
  async transition(legacyValue, current, atMs) {
    return this.#serial(async () => {
      const previous = await this.#read(legacyValue);
      const { next, alert } = hostHealthTransition(previous.state, current);
      if (next !== previous.state) {
        const updated = asState({ state: next, atMs });
        await this.ctx.storage.put(STATE_KEY, updated);
        await this.#mirror(updated);
      }
      return { previous: previous.state, next, alert };
    });
  }

  /** @param {AgentHostHealthState} state */
  async #mirror(state) {
    const kv = /** @type {Env} */ (this.env).BRIEFING;
    if (!kv || typeof kv.put !== 'function') return;
    try {
      await kv.put(AGENT_HOST_HEALTH_KEY, JSON.stringify(state));
    } catch (/** @type {any} */ error) {
      console.error('agent-host-health: legacy mirror не записано', error?.message);
    }
  }
}
