import { WEEKLY_REVIEW_STATE_DO_NAME, WEEKLY_REVIEW_STATE_KEY } from './contract.mjs';
/** @param {Env} env @returns {any|null} */ function target(env) {
  const ns = env.WEEKLY_REVIEW_STATE;
  return typeof ns?.getByName === 'function' ? ns.getByName(WEEKLY_REVIEW_STATE_DO_NAME) : null;
}
/** @param {Env} env @param {unknown} state @param {number} nowMs @param {number} leaseMs */ export async function weeklyClaim(
  env,
  state,
  nowMs,
  leaseMs,
) {
  const stub = target(env);
  if (!stub) return { canonical: false, ok: true, token: null, state };
  try {
    return { canonical: true, ...(await stub.claim(state, nowMs, leaseMs)) };
  } catch (/** @type {any} */ error) {
    console.error('weekly-review: claim впав', error?.message);
    return { canonical: true, ok: false, reason: 'unavailable' };
  }
}
/** @param {Env} env @param {string|null|undefined} token @param {unknown} state */ export async function weeklyComplete(
  env,
  token,
  state,
) {
  const stub = target(env);
  if (!stub) {
    await env.BRIEFING.put(WEEKLY_REVIEW_STATE_KEY, JSON.stringify(state));
    return true;
  }
  return Boolean(await stub.complete(token, state));
}
/** @param {Env} env @param {string|null|undefined} token */ export async function weeklyRelease(
  env,
  token,
) {
  const stub = target(env);
  return !stub || Boolean(await stub.release(token));
}
