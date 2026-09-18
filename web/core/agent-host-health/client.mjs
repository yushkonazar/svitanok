import { AGENT_HOST_HEALTH_DO_NAME } from './contract.mjs';

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.AGENT_HOST_HEALTH;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(AGENT_HOST_HEALTH_DO_NAME))
    : null;
}

/**
 * @param {Env} env @param {unknown} legacyValue @param {'ok'|'desync'|'unknown'} current
 * @param {number} atMs
 * @returns {Promise<{ canonical: boolean, previous?: string, next?: string, alert?: string|null }>} */
export async function agentHostHealthTransition(env, legacyValue, current, atMs) {
  const target = stub(env);
  if (!target) return { canonical: false };
  try {
    return { canonical: true, ...(await target.transition(legacyValue, current, atMs)) };
  } catch (/** @type {any} */ error) {
    // Health probes are observational. On control-plane trouble, suppress an
    // uncertain notification rather than potentially send duplicate alerts.
    console.error('agent-host-health: atomic transition впав; alert пропущено', error?.message);
    return { canonical: true, alert: null };
  }
}
