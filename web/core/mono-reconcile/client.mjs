import { MONO_RECONCILE_DO_NAME } from './contract.mjs';

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.MONO_RECONCILE;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(MONO_RECONCILE_DO_NAME))
    : null;
}

/** @param {Env} env @param {unknown} legacyValue */
export async function monoReconcileRead(env, legacyValue) {
  const target = stub(env);
  if (!target) return { canonical: false, state: legacyValue };
  try {
    return { canonical: true, state: await target.read(legacyValue) };
  } catch (/** @type {any} */ error) {
    console.error('mono-reconcile: canonical read впав; legacy fallback', error?.message);
    return { canonical: false, state: legacyValue };
  }
}

/** @param {Env} env @param {unknown} legacyValue @param {number} nowMs @param {number} leaseMs */
export async function monoReconcileClaim(env, legacyValue, nowMs, leaseMs) {
  const target = stub(env);
  if (!target) return { canonical: false, ok: true, state: legacyValue, token: null };
  try {
    return { canonical: true, ...(await target.claim(legacyValue, nowMs, leaseMs)) };
  } catch (/** @type {any} */ error) {
    console.error('mono-reconcile: canonical claim впав; tick пропущено', error?.message);
    return { canonical: true, ok: false, reason: 'unavailable' };
  }
}

/** @param {Env} env @param {string|null|undefined} token @param {unknown} state */
export async function monoReconcileComplete(env, token, state) {
  const target = stub(env);
  if (!target) {
    await env.BRIEFING.put('monoReconcile', JSON.stringify(state));
    return true;
  }
  return Boolean(await target.complete(token, state));
}

/** @param {Env} env @param {string|null|undefined} token */
export async function monoReconcileRelease(env, token) {
  const target = stub(env);
  if (!target) return true;
  return Boolean(await target.release(token));
}
