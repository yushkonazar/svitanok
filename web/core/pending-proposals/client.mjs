// Platform-clean client for PendingProposalsDO. Pure patches stay in Worker
// code and are retried through versioned CAS; the DO never executes caller
// supplied code and never exposes its storage record directly to Telegram.

import { ASSISTANT_PENDING_KEY, PENDING_PROPOSALS_DO_NAME } from './contract.mjs';

const MAX_CAS_ATTEMPTS = 4;

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asPending(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {Env} env @returns {any|null} */
function stub(env) {
  const ns = env.PENDING_PROPOSALS;
  return typeof ns?.getByName === 'function'
    ? /** @type {any} */ (ns.getByName(PENDING_PROPOSALS_DO_NAME))
    : null;
}

/** @param {Env} env @param {unknown} legacyValue
 * @returns {Promise<{ canonical: boolean, pending: Record<string, unknown> | null }>} */
export async function pendingRead(env, legacyValue) {
  const target = stub(env);
  if (!target) return { canonical: false, pending: asPending(legacyValue) };
  // Binding є в production. Якщо canonical read недоступний, не можна
  // підміняти його potentially stale KV і ризикувати повторною дією.
  const record = await target.read(legacyValue);
  return { canonical: true, pending: asPending(record?.value) };
}

/** @param {Env} env @param {Record<string, unknown> | null} pending
 * @returns {Promise<boolean>} true = canonical write */
export async function pendingReplace(env, pending) {
  const target = stub(env);
  if (!target) return false;
  await target.replace(pending);
  return true;
}

/** Атомарний claim; `null` означає legacy path без binding. Помилка доступного
 * DO не переходить у KV fallback: ця операція передує зовнішньому ефекту.
 * @param {Env} env @param {string} id @returns {Promise<boolean | null>} */
export async function pendingClaim(env, id) {
  const target = stub(env);
  if (!target) return null;
  return Boolean(await target.claim(id));
}

/** Застосувати чисту мутацію до pending із CAS retry. `canonical:false`
 * означає відсутній binding у rollback/local runtime: викликачу слід лишити
 * legacy RMW. Помилка доступного DO навмисно поширюється вгору.
 * @param {Env} env
 * @param {string} id
 * @param {(pending: Record<string, unknown>) => Record<string, unknown>} patch
 * @returns {Promise<{ canonical: boolean, ok: boolean, pending: Record<string, unknown> | null }>} */
export async function pendingUpdate(env, id, patch) {
  const target = stub(env);
  if (!target) return { canonical: false, ok: false, pending: null };
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await target.read(null);
    const pending = asPending(current?.value);
    if (!pending || pending.id !== id) return { canonical: true, ok: false, pending: null };
    const next = patch(pending);
    const result = await target.compareAndSet(current.version, next);
    if (result?.ok) return { canonical: true, ok: true, pending: asPending(result.record?.value) };
  }
  console.error(`pending-proposals: CAS не зійшовся за ${MAX_CAS_ATTEMPTS} спроб`);
  return { canonical: true, ok: false, pending: null };
}

/** T2 canonical cleanup. Відсутній binding = legacy only. @param {Env} env */
export async function pendingClear(env) {
  const target = stub(env);
  if (!target) return { canonical: false, cleared: false };
  try {
    const result = await target.clear();
    return { canonical: true, cleared: Boolean(result?.cleared) };
  } catch (/** @type {any} */ error) {
    // `forget all` не має вдавати успіх, якщо canonical copy лишилась.
    throw new Error(`pending-proposals: clear впав: ${String(error?.message ?? error)}`, {
      cause: error,
    });
  }
}

export { ASSISTANT_PENDING_KEY };
