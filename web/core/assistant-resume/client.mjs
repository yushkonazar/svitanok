// Platform-clean client for short-lived assistant continuation notes. When the
// binding exists, an unavailable DO deliberately fails closed on take: stale
// KV must not make the same note visible to two concurrent messages.

import {
  ASSISTANT_RESUME_DO_NAME,
  ASSISTANT_RESUME_TTL_MS,
  assistantResumeLegacyKey,
  assistantResumeSlot,
} from './contract.mjs';

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
 * @param {string|number|null|undefined} threadId @param {unknown} value
 * @param {number} [nowMs] */
export async function assistantResumeRestoreIfEmpty(
  env,
  chatId,
  threadId,
  value,
  nowMs = Date.now(),
) {
  const target = stub(env);
  const slot = assistantResumeSlot(chatId, threadId);
  if (target) {
    try {
      return Boolean(await target.restoreIfEmpty(slot, value, nowMs));
    } catch (/** @type {any} */ error) {
      console.error('assistant-resume: restore впав', error?.message);
      return false;
    }
  }
  // Compatibility path for rollback/local runs. KV has no compare-and-swap;
  // preserve an already-visible newer note instead of overwriting it.
  const kv = env.BRIEFING;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return false;
  try {
    if (await kv.get(assistantResumeLegacyKey(slot))) return false;
    const resume = /** @type {{ note?: unknown, atMs?: unknown } | null} */ (
      value && typeof value === 'object' ? value : null
    );
    if (!resume || typeof resume.note !== 'string' || !Number.isFinite(resume.atMs)) return false;
    await kv.put(assistantResumeLegacyKey(slot), JSON.stringify(resume), {
      expirationTtl: Math.ceil(ASSISTANT_RESUME_TTL_MS / 1000),
    });
    return true;
  } catch (/** @type {any} */ error) {
    console.error('assistant-resume: KV restore впав', error?.message);
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
