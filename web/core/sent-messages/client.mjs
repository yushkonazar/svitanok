// Platform-clean client for SentMessagesDO. It exposes domain operations, not
// a generic blob setter, so production callers cannot reintroduce KV-style RMW.

import { SENT_MESSAGES_DO_NAME } from './contract.mjs';

/** @param {unknown} value @returns {Record<string, unknown>} */
function asBlob(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.SENT_MESSAGES;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(SENT_MESSAGES_DO_NAME))
    : null;
}

/** @param {Env} env @param {unknown} legacyValue
 * @returns {Promise<{ canonical: boolean, value: Record<string, unknown> }>} */
export async function sentMessagesRead(env, legacyValue) {
  const target = stub(env);
  if (!target) return { canonical: false, value: asBlob(legacyValue) };
  const record = await target.read(legacyValue);
  return { canonical: true, value: asBlob(record?.value) };
}

/** @param {Env} env @param {unknown} legacyValue
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId
 * @param {number} messageId @param {boolean} [own]
 * @returns {Promise<{ canonical: boolean, value: Record<string, unknown> }>} */
export async function sentMessagesRecord(
  env,
  legacyValue,
  chatId,
  threadId,
  messageId,
  own = false,
) {
  const target = stub(env);
  if (!target) return { canonical: false, value: {} };
  const record = await target.record(legacyValue, chatId, threadId, messageId, own);
  return { canonical: true, value: asBlob(record?.value) };
}

/** @param {Env} env @param {unknown} legacyValue
 * @param {string|number|null|undefined} chatId
 * @param {string|number|null|undefined} threadId @param {number[]} ids
 * @returns {Promise<{ canonical: boolean, value: Record<string, unknown> }>} */
export async function sentMessagesForget(env, legacyValue, chatId, threadId, ids) {
  const target = stub(env);
  if (!target) return { canonical: false, value: {} };
  const record = await target.forget(legacyValue, chatId, threadId, ids);
  return { canonical: true, value: asBlob(record?.value) };
}

/** Legacy/local compatibility only; production code uses domain mutations.
 * @param {Env} env @param {Record<string, unknown>} value @returns {Promise<boolean>} */
export async function sentMessagesReplace(env, value) {
  const target = stub(env);
  if (!target) return false;
  await target.replace(value);
  return true;
}

/** @param {Env} env @returns {Promise<boolean>} */
export async function sentMessagesClear(env) {
  const target = stub(env);
  if (!target) return false;
  await target.clear();
  return true;
}
