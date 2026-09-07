// Клієнт ядро→мозок (ADR-038/039): POST /run і POST /abort за Tunnel.
// Підпис - той самий ADR-037 (signInternal по сирому тілу), плюс Access
// service token. run_id МУСИТЬ бути зареєстрованим (registryBegin) ДО виклику:
// мозок відповідає назад у /internal/*, а роутер відкидає невідомі прогони.
// Місконфіг - явна відмова з причиною, не тихий пропуск (00-README п.6).
//
// Спільний транспорт signedBrainPost (ревʼю PR-3: дві копії підпису/Access/
// таймауту тихо розʼїхались би) - callBrainRun/callBrainAbort лише
// інтерпретують статус.

import { signedInternalHeaders } from '../internal/auth.mjs';

const RUN_TIMEOUT_MS = 10_000;

/**
 * Підписаний POST у мозок. status 0 = транспортна невизначеність (мережа або
 * таймаут - запит МІГ дійти); body - розібраний JSON відповіді або null.
 * @param {Env} env
 * @param {string} path
 * @param {string} runId
 * @param {string} rawBody
 * @param {number} nowMs
 * @returns {Promise<{ status: number, body: any } | { misconfig: string }>}
 */
async function signedBrainPost(env, path, runId, rawBody, nowMs) {
  const url = String(env.BRAIN_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const key = String(env.INTERNAL_HMAC_KEY ?? '').trim();
  const clientId = String(env.BRAIN_ACCESS_CLIENT_ID ?? '').trim();
  const clientSecret = String(env.BRAIN_ACCESS_CLIENT_SECRET ?? '').trim();
  if (!url) return { misconfig: 'BRAIN_URL не задано' };
  if (!key) return { misconfig: 'INTERNAL_HMAC_KEY не задано' };

  const headers = await signedInternalHeaders(key, {
    method: 'POST',
    path,
    runId,
    rawBody,
    nowMs,
    access: clientId && clientSecret ? { clientId, clientSecret } : null,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: ctrl.signal,
    });
    const body = /** @type {any} */ (await res.json().catch(() => null));
    return { status: res.status, body };
  } catch (/** @type {any} */ e) {
    return { status: 0, body: { error: `мозок недосяжний: ${String(e?.message ?? 'мережа')}` } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Env} env
 * @param {{
 *   runId: string,
 *   profile: 'chat' | 'quick' | 'summarize' | 'weekly-review' | 'day-planner' | 'price-check',
 *   threadId: string,
 *   inputText: string,
 *   tainted?: boolean,
 *   statusMessageId?: number,
 *   session?: { sdk_session_id: string | null, summary_md: string | null },
 *   instruction?: { name: string, version_hash: string, body_md: string },
 * }} req
 * @param {number} nowMs
 * @returns {Promise<{ ok: true } | { ok: false, status: number, detail: string }>}
 */
export async function callBrainRun(env, req, nowMs) {
  const rawBody = JSON.stringify({
    run_id: req.runId,
    profile: req.profile,
    thread_id: req.threadId,
    input: { text: req.inputText },
    ...(req.tainted != null ? { tainted: req.tainted } : {}),
    ...(req.statusMessageId != null ? { status_message_id: req.statusMessageId } : {}),
    ...(req.session ? { session: req.session } : {}),
    ...(req.instruction ? { instruction: req.instruction } : {}),
  });
  const res = await signedBrainPost(env, '/run', req.runId, rawBody, nowMs);
  if ('misconfig' in res) return { ok: false, status: 0, detail: res.misconfig };
  if (res.status === 202) return { ok: true };
  return { ok: false, status: res.status, detail: String(res.body?.error ?? `HTTP ${res.status}`) };
}

/**
 * «стоп» (ADR-039): POST /abort мозку - перервати активний прогін.
 * @param {Env} env
 * @param {string} runId
 * @param {number} nowMs
 * @returns {Promise<{ ok: true, aborted: boolean } | { ok: false, status: number, detail: string }>}
 */
export async function callBrainAbort(env, runId, nowMs) {
  const rawBody = JSON.stringify({ run_id: runId });
  const res = await signedBrainPost(env, '/abort', runId, rawBody, nowMs);
  if ('misconfig' in res) return { ok: false, status: 0, detail: res.misconfig };
  if (res.status === 200) return { ok: true, aborted: Boolean(res.body?.aborted) };
  return { ok: false, status: res.status, detail: String(res.body?.error ?? `HTTP ${res.status}`) };
}
