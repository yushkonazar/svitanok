import { DurableObject } from 'cloudflare:workers';
import { MONO_UNKNOWN_ALERT_KEY } from './contract.mjs';
const KEY = 'last';
export class MonoAlertGateDO extends DurableObject {
  #ops = Promise.resolve();
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */ #serial(work) {
    const next = this.#ops.then(work, work);
    this.#ops = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /** @param {unknown} legacy @param {number} nowMs @param {number} windowMs */ async claim(
    legacy,
    nowMs,
    windowMs,
  ) {
    return this.#serial(async () => {
      const stored = await this.ctx.storage.get(KEY);
      const last = Number(stored ?? legacy ?? 0);
      if (last > 0 && nowMs - last < windowMs) return { ok: false, last };
      await this.ctx.storage.put(KEY, nowMs);
      try {
        await this.env.BRIEFING?.put?.(MONO_UNKNOWN_ALERT_KEY, String(nowMs));
      } catch (/** @type {any} */ error) {
        console.error('mono-alert-gate: mirror не записано', error?.message);
      }
      return { ok: true, last: nowMs };
    });
  }
}
