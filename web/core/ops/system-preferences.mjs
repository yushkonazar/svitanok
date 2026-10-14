import { USAGE_FEATURES } from './usage-ledger.mjs';
/** @param {Env} env */
export async function readSystemPreferences(env) {
  if (!env.DB) throw new Error('storage');
  const row = await env.DB.prepare(
    "SELECT value_json,revision FROM system_preferences WHERE id='owner'",
  )
    .bind()
    .first();
  return {
    revision: Number(row?.revision ?? 0),
    budgets: row ? JSON.parse(String(row.value_json)) : { overallUsd: null, features: {} },
    enforcement: false,
    notifications: false,
  };
}
/** Display-only monthly envelopes. No external cap, notifications or module
 * switches are changed by saving a budget. Concurrent edits use revision CAS.
 * @param {Env} env @param {any} input @param {number} [nowMs] */
export async function saveSystemPreferences(env, input, nowMs = Date.now()) {
  if (!env.DB) return { ok: false, error: 'storage' };
  if (
    !Number.isSafeInteger(input?.revision) ||
    input.revision < 0 ||
    !input.budgets ||
    typeof input.budgets !== 'object'
  )
    return { ok: false, error: 'invalid' };
  const money = (/** @type {unknown} */ value) =>
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      Number.isSafeInteger(Math.round(value * 1e9)));
  if (
    !money(input.budgets.overallUsd) ||
    !input.budgets.features ||
    Array.isArray(input.budgets.features) ||
    typeof input.budgets.features !== 'object'
  )
    return { ok: false, error: 'invalid' };
  /** @type {Record<string,number>} */ const features = {};
  for (const [key, value] of Object.entries(input.budgets.features)) {
    if (!USAGE_FEATURES.includes(key) || !money(value)) return { ok: false, error: 'invalid' };
    if (typeof value === 'number') features[key] = value;
  }
  const budgets = { overallUsd: input.budgets.overallUsd, features };
  const statement =
    input.revision === 0
      ? env.DB.prepare(
          "INSERT INTO system_preferences(id,value_json,revision,updated_at) VALUES('owner',?,1,?) ON CONFLICT(id) DO NOTHING RETURNING revision",
        ).bind(JSON.stringify(budgets), new Date(nowMs).toISOString())
      : env.DB.prepare(
          "UPDATE system_preferences SET value_json=?,revision=revision+1,updated_at=? WHERE id='owner' AND revision=? RETURNING revision",
        ).bind(JSON.stringify(budgets), new Date(nowMs).toISOString(), input.revision);
  const result = await statement.all();
  const committed = result.results?.[0];
  if (!committed) return { ok: false, error: 'conflict' };
  return {
    ok: true,
    preferences: {
      revision: Number(committed.revision),
      budgets,
      enforcement: false,
      notifications: false,
    },
  };
}
