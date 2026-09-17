import { BRIEF_DISPATCH_DO_NAME } from './contract.mjs';

/** @param {unknown} value */
function asState(value) {
  const raw = /** @type {Record<string, unknown>} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  return {
    lastMs: Number.isFinite(raw.lastMs) && Number(raw.lastMs) > 0 ? Number(raw.lastMs) : null,
    lastAutoDate:
      typeof raw.lastAutoDate === 'string' && raw.lastAutoDate ? raw.lastAutoDate : null,
  };
}

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.BRIEF_DISPATCH;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(BRIEF_DISPATCH_DO_NAME))
    : null;
}

/** @param {Env} env @param {unknown} legacyValue */
export async function briefDispatchRead(env, legacyValue) {
  const target = stub(env);
  if (!target) return { canonical: false, state: asState(legacyValue) };
  try {
    return { canonical: true, state: asState(await target.read(legacyValue)) };
  } catch (/** @type {any} */ error) {
    // Читання потрібне лише для дружнього пояснення кулдауну. Власне claim
    // нижче fail-closed, тому fallback тут не може спричинити другий dispatch.
    console.error('brief-dispatch: canonical read впав; legacy read only', error?.message);
    return { canonical: false, state: asState(legacyValue) };
  }
}

/** @param {Env} env @param {unknown} legacyValue @param {number} nowMs
 * @param {string|null} autoDate @param {number} minGapMs */
export async function briefDispatchClaim(env, legacyValue, nowMs, autoDate, minGapMs) {
  const target = stub(env);
  if (!target) return { canonical: false, ok: true, token: null };
  try {
    const result = await target.claim(legacyValue, nowMs, autoDate, minGapMs);
    return { canonical: true, ...result };
  } catch (/** @type {any} */ error) {
    // Після активації binding-а помилка control plane не повинна відкривати
    // шлях до зовнішнього ефекту: недоступний DO = ніякого другого dispatch.
    console.error('brief-dispatch: atomic claim впав; dispatch заблоковано', error?.message);
    return { canonical: true, ok: false, reason: 'unavailable' };
  }
}

/** @param {Env} env @param {string|null} token @param {number} nowMs @param {string|null} autoDate */
export async function briefDispatchComplete(env, token, nowMs, autoDate) {
  const target = stub(env);
  if (!target || !token) return false;
  return Boolean(await target.complete(token, nowMs, autoDate));
}

/** @param {Env} env @param {string|null} token */
export async function briefDispatchRelease(env, token) {
  const target = stub(env);
  if (!target || !token) return false;
  return Boolean(await target.release(token));
}
