import { BACKUP_STATE_DO_NAME, BACKUP_STATE_KEY } from './contract.mjs';
/** @param {Env} env @returns {any|null} */
function target(env) {
  const ns = env.BACKUP_STATE;
  return typeof ns?.getByName === 'function' ? ns.getByName(BACKUP_STATE_DO_NAME) : null;
}
/** @param {Env} env @param {unknown} legacy @param {number} nowMs @param {number} leaseMs */
export async function backupStateClaim(env, legacy, nowMs, leaseMs) {
  const stub = target(env);
  if (!stub) return { canonical: false, ok: true, token: null, state: legacy };
  try {
    return { canonical: true, ...(await stub.claim(legacy, nowMs, leaseMs)) };
  } catch (/** @type {any} */ error) {
    console.error('backup-state: claim впав; tick пропущено', error?.message);
    return { canonical: true, ok: false, reason: 'unavailable' };
  }
}
/** @param {Env} env @param {string|null|undefined} token @param {unknown} state */
export async function backupStateComplete(env, token, state) {
  const stub = target(env);
  if (!stub) {
    await env.BRIEFING.put(BACKUP_STATE_KEY, JSON.stringify(state));
    return true;
  }
  return Boolean(await stub.complete(token, state));
}
/** @param {Env} env @param {string|null|undefined} token */
export async function backupStateRelease(env, token) {
  const stub = target(env);
  return !stub || Boolean(await stub.release(token));
}
