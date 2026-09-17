// Platform-clean client for short-lived assistant continuation notes. When the
// binding exists, an unavailable DO deliberately fails closed on take: stale
// KV must not make the same note visible to two concurrent messages.

import { ASSISTANT_RESUME_DO_NAME, assistantResumeSlot } from './contract.mjs';

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.ASSISTANT_RESUME;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(ASSISTANT_RESUME_DO_NAME))
    : null;
}

/** @param {Env} env @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId @param {unknown} value
 * @param {number} [nowMs] */
export async function assistantResumeSave(env, chatId, threadId, value, nowMs = Date.now()) {
  const target = stub(env);
  if (!target) return false;
  try {
    return Boolean(await target.save(assistantResumeSlot(chatId, threadId), value, nowMs));
  } catch (/** @type {any} */ error) {
    // The caller may mirror the identical note to legacy KV for rollback. That
    // cannot execute an external effect and gives a later healthy DO a seed.
    console.error('assistant-resume: canonical save впав; legacy fallback', error?.message);
    return false;
  }
}

/** @param {Env} env @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId @param {unknown} legacyValue
 * @param {number} [nowMs]
 * @returns {Promise<{ canonical: boolean, resume: unknown }>} */
export async function assistantResumeTake(env, chatId, threadId, legacyValue, nowMs = Date.now()) {
  const target = stub(env);
  if (!target) return { canonical: false, resume: legacyValue };
  try {
    return {
      canonical: true,
      resume: await target.take(assistantResumeSlot(chatId, threadId), legacyValue, nowMs),
    };
  } catch (/** @type {any} */ error) {
    console.error('assistant-resume: atomic take впав; stale fallback заблоковано', error?.message);
    return { canonical: true, resume: null };
  }
}

/** @param {Env} env */
export async function assistantResumeClear(env) {
  const target = stub(env);
  if (!target) return { canonical: false, cleared: false };
  const result = await target.clear();
  return { canonical: true, cleared: Boolean(result?.cleared) };
}
