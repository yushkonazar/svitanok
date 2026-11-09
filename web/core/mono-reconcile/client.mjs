import { MONO_RECONCILE_DO_NAME } from './contract.mjs';

const INBOX_NAME = 'mono-webhook-inbox';

/** @param {Env} env @param {string} [name] @returns {any|null} */
function stub(env, name = MONO_RECONCILE_DO_NAME) {
  const ns = env.MONO_RECONCILE;
  return typeof ns?.getByName === 'function' ? /** @type {any} */ (ns.getByName(name)) : null;
}

/** @typedef {{ receipt: string, account: string, item: import('../adapters/mono.mjs').MonoStatementItem, receivedAt: number }} QueuedMonoWebhook */

/** @param {Env} env @param {string} account @param {QueuedMonoWebhook['item']} item @param {number} receivedAt */
export async function enqueueMonoWebhook(env, account, item, receivedAt) {
  return Boolean(await stub(env, INBOX_NAME)?.enqueueWebhook(account, item, receivedAt));
}

/** @param {Env} env @param {number} nowMs @returns {Promise<QueuedMonoWebhook[]>} */
export async function readMonoWebhookInbox(env, nowMs) {
  const target = stub(env, INBOX_NAME);
  return typeof target?.readWebhookInbox === 'function' ? await target.readWebhookInbox(nowMs) : [];
}

/** @param {Env} env @param {number} nowMs */
export async function claimMonoWebhookCatalogRefresh(env, nowMs) {
  return Boolean(await stub(env, INBOX_NAME)?.claimWebhookCatalogRefresh(nowMs));
}

/** @param {Env} env @param {string} receipt */
export async function completeMonoWebhook(env, receipt) {
  await stub(env, INBOX_NAME)?.completeWebhook(receipt);
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
