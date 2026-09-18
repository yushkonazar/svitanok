import { MONO_ALERT_GATE_DO_NAME, MONO_UNKNOWN_ALERT_KEY } from './contract.mjs';
/** @param {Env} env @returns {any|null} */ function target(env) {
  const ns = env.MONO_ALERT_GATE;
  return typeof ns?.getByName === 'function' ? ns.getByName(MONO_ALERT_GATE_DO_NAME) : null;
}
/** @param {Env} env @param {number} legacy @param {number} nowMs @param {number} windowMs */ export async function monoAlertClaim(
  env,
  legacy,
  nowMs,
  windowMs,
) {
  const stub = target(env);
  if (!stub) {
    if (legacy > 0 && nowMs - legacy < windowMs) return { canonical: false, ok: false };
    await env.BRIEFING.put(MONO_UNKNOWN_ALERT_KEY, String(nowMs));
    return { canonical: false, ok: true };
  }
  try {
    return { canonical: true, ...(await stub.claim(legacy, nowMs, windowMs)) };
  } catch (/** @type {any} */ error) {
    console.error('mono-alert-gate: claim впав; alert пропущено', error?.message);
    return { canonical: true, ok: false };
  }
}
