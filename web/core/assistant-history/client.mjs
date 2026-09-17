// Platform-clean client for AssistantHistoryDO. Production writers append
// domain turns, never a stale whole history blob.

import { ASSISTANT_HISTORY_DO_NAME } from './contract.mjs';

/** @param {unknown} value @returns {Record<string, unknown>} */
function asBlob(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.ASSISTANT_HISTORY;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(ASSISTANT_HISTORY_DO_NAME))
    : null;
}

/** @param {Env} env @param {unknown} legacyValue @param {number} [nowMs]
 * @returns {Promise<{ canonical: boolean, history: Record<string, unknown> }>} */
export async function historyRead(env, legacyValue, nowMs = Date.now()) {
  const target = stub(env);
  if (!target) return { canonical: false, history: asBlob(legacyValue) };
  try {
    const record = await target.read(legacyValue, nowMs);
    return { canonical: true, history: asBlob(record?.history) };
  } catch (/** @type {any} */ error) {
    // Context is best-effort: an unavailable DO must not make a new agent run
    // fail before it even received its task. Writers keep the same outer catch.
    console.error('assistant-history: read впав; legacy fallback', error?.message);
    return { canonical: false, history: asBlob(legacyValue) };
  }
}

/** @param {Env} env @param {unknown} legacyValue
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {{ role: string, text: string }[]} turns @param {number} [nowMs]
 * @returns {Promise<{ canonical: boolean, history: Record<string, unknown> }>} */
export async function historyAppend(env, legacyValue, chatId, threadId, turns, nowMs = Date.now()) {
  const target = stub(env);
  if (!target) return { canonical: false, history: {} };
  const record = await target.append(legacyValue, chatId, threadId, turns, nowMs);
  return { canonical: true, history: asBlob(record?.history) };
}

/** Legacy/local compatibility only. @param {Env} env @param {Record<string, unknown>} history
 * @returns {Promise<boolean>} */
export async function historyReplace(env, history) {
  const target = stub(env);
  if (!target) return false;
  await target.replace(history);
  return true;
}

/** @param {Env} env @returns {Promise<boolean>} */
export async function historyClear(env) {
  const target = stub(env);
  if (!target) return false;
  await target.clear();
  return true;
}
