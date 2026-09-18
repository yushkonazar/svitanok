import { INBOX_COUNT_KEY, INBOX_QUOTA_DO_NAME } from './contract.mjs';

/** @param {unknown} value */
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

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.INBOX_QUOTA;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(INBOX_QUOTA_DO_NAME))
    : null;
}

/** @param {Env} env @param {{ date: string|null, n: number, alerted: boolean }} state */
async function mirror(env, state) {
  try {
    await env.BRIEFING.put(INBOX_COUNT_KEY, JSON.stringify(state));
  } catch (/** @type {any} */ error) {
    // The compatibility path intentionally keeps the old contract: a broken
    // counter must not silently discard a real incoming message.
    console.error('inbox: лічильник доби не записано (повідомлення зберігаю)', error?.message);
  }
}

/**
 * Reserve one inbox row. The canonical path is atomic. If an already-bound
 * Durable Object becomes unavailable, the message is still retained: a
 * transient quota-control failure must not become data loss.
 * @param {Env} env @param {unknown} legacyValue @param {string} date @param {number} limit
 */
export async function inboxQuotaTake(env, legacyValue, date, limit) {
  const target = stub(env);
  if (target) {
    try {
      return { canonical: true, ...(await target.take(legacyValue, date, limit)) };
    } catch (/** @type {any} */ error) {
      console.error('inbox-quota: atomic reserve впав; повідомлення зберігаю', error?.message);
      return { canonical: true, allowed: true, alert: false, degraded: true };
    }
  }

  const current = asState(legacyValue);
  const base = current.date === date ? current : { date, n: 0, alerted: false };
  const safeLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;
  if (base.n >= safeLimit) {
    const next = base.alerted ? base : { ...base, alerted: true };
    if (!base.alerted) await mirror(env, next);
    return { canonical: false, allowed: false, alert: !base.alerted, n: base.n };
  }
  const next = { ...base, n: base.n + 1 };
  await mirror(env, next);
  return { canonical: false, allowed: true, alert: false, n: next.n };
}

/** @param {Env} env */
export async function inboxQuotaClear(env) {
  const target = stub(env);
  if (!target) return { canonical: false, cleared: false };
  const result = await target.clear();
  return { canonical: true, cleared: Boolean(result?.cleared) };
}
