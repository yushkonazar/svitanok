import { WEATHER_LIVE_COUNTER_KEY, WEATHER_QUOTA_DO_NAME } from './contract.mjs';

/** @param {unknown} value */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  return {
    date: typeof raw.date === 'string' && raw.date ? raw.date : null,
    count: Number.isInteger(raw.count) && Number(raw.count) >= 0 ? Number(raw.count) : 0,
  };
}

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.WEATHER_QUOTA;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(WEATHER_QUOTA_DO_NAME))
    : null;
}

/** @param {Env} env @param {unknown} legacyValue @param {string} date
 * @param {number} amount @param {number} limit */
export async function weatherQuotaConsume(env, legacyValue, date, amount, limit) {
  const target = stub(env);
  if (target) {
    try {
      return { canonical: true, ...(await target.consume(legacyValue, date, amount, limit)) };
    } catch (/** @type {any} */ error) {
      // The next operation would call a paid/shared external API, so an enabled
      // but unavailable canonical quota must fail closed rather than overspend.
      console.error('weather-quota: atomic reserve впав; OpenWeather заблоковано', error?.message);
      return { canonical: true, ok: false, remaining: 0, reason: 'unavailable' };
    }
  }
  const current = asState(legacyValue);
  const base = current.date === date ? current : { date, count: 0 };
  if (!Number.isInteger(amount) || amount <= 0 || base.count + amount > limit) {
    return { canonical: false, ok: false, remaining: Math.max(0, limit - base.count) };
  }
  const next = { date, count: base.count + amount };
  await env.BRIEFING.put(WEATHER_LIVE_COUNTER_KEY, JSON.stringify(next));
  return { canonical: false, ok: true, count: next.count, remaining: limit - next.count };
}

/** @param {Env} env */
export async function weatherQuotaClear(env) {
  const target = stub(env);
  if (!target) return { canonical: false, cleared: false };
  const result = await target.clear();
  return { canonical: true, cleared: Boolean(result?.cleared) };
}
