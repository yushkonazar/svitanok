import {
  normalizeSteamCheckState,
  STEAM_CHECK_STATE_DO_NAME,
  STEAM_MARKER_KEY,
  STEAM_MISS_KEY,
  STEAM_SALE_KEY,
} from './contract.mjs';

/** @param {Env} env @returns {any|null} */
function target(env) {
  const ns = env.STEAM_CHECK_STATE;
  return typeof ns?.getByName === 'function' ? ns.getByName(STEAM_CHECK_STATE_DO_NAME) : null;
}

/** @param {Env} env */
export async function readSteamCheckLegacy(env) {
  const [marker, misses, saleShare] = await Promise.all([
    env.BRIEFING.get(STEAM_MARKER_KEY),
    env.BRIEFING.get(STEAM_MISS_KEY),
    env.BRIEFING.get(STEAM_SALE_KEY),
  ]);
  return { marker, misses, saleShare };
}

/** @param {Env} env @param {unknown} legacy @param {string} today @param {number} nowMs @param {number} leaseMs */
export async function steamCheckClaim(env, legacy, today, nowMs, leaseMs) {
  const stub = target(env);
  const state = normalizeSteamCheckState(legacy);
  if (!stub) {
    if (state.completedDay === today) return { canonical: false, ok: false, reason: 'done' };
    return { canonical: false, ok: true, token: null, state };
  }
  try {
    return { canonical: true, ...(await stub.claim(legacy, today, nowMs, leaseMs)) };
  } catch (/** @type {any} */ error) {
    console.error('steam-check-state: claim впав; tick пропущено', error?.message);
    return { canonical: true, ok: false, reason: 'unavailable' };
  }
}

/** @param {Env} env @param {string|null|undefined} token @param {unknown} next */
export async function steamCheckComplete(env, token, next) {
  const stub = target(env);
  const state = normalizeSteamCheckState(next);
  if (stub) return Boolean(await stub.complete(token, state));
  await Promise.all([
    env.BRIEFING.put(STEAM_MARKER_KEY, state.completedDay),
    env.BRIEFING.put(STEAM_MISS_KEY, String(state.misses)),
    env.BRIEFING.put(STEAM_SALE_KEY, String(state.saleShare)),
  ]);
  return true;
}

/** @param {Env} env @param {string|null|undefined} token */
export async function steamCheckRelease(env, token) {
  const stub = target(env);
  return !stub || Boolean(await stub.release(token));
}
