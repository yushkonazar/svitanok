// Клієнт ядро→мозок (ADR-038): POST /run за Tunnel - перший бойовий викликач.
// Підпис - той самий ADR-037 (signInternal по сирому тілу), плюс Access
// service token. run_id МУСИТЬ бути зареєстрованим (registryBegin) ДО виклику:
// мозок відповідає назад у /internal/*, а роутер відкидає невідомі прогони.
// Місконфіг - явна відмова з причиною, не тихий пропуск (00-README п.6).

import { signInternal } from '../internal/auth.mjs';

const RUN_TIMEOUT_MS = 10_000;

/**
 * @param {Env} env
 * @param {{
 *   runId: string,
 *   profile: 'chat' | 'quick' | 'summarize',
 *   threadId: string,
 *   inputText: string,
 *   tainted?: boolean,
 *   statusMessageId?: number,
 *   session?: { sdk_session_id: string | null, summary_md: string | null },
 * }} req
 * @param {number} nowMs
 * @returns {Promise<{ ok: true } | { ok: false, status: number, detail: string }>}
 */
export async function callBrainRun(env, req, nowMs) {
  const url = String(env.BRAIN_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const key = String(env.INTERNAL_HMAC_KEY ?? '').trim();
  const clientId = String(env.BRAIN_ACCESS_CLIENT_ID ?? '').trim();
  const clientSecret = String(env.BRAIN_ACCESS_CLIENT_SECRET ?? '').trim();
  if (!url) return { ok: false, status: 0, detail: 'BRAIN_URL не задано' };
  if (!key) return { ok: false, status: 0, detail: 'INTERNAL_HMAC_KEY не задано' };

  const rawBody = JSON.stringify({
    run_id: req.runId,
    profile: req.profile,
    thread_id: req.threadId,
    input: { text: req.inputText },
    ...(req.tainted != null ? { tainted: req.tainted } : {}),
    ...(req.statusMessageId != null ? { status_message_id: req.statusMessageId } : {}),
    ...(req.session ? { session: req.session } : {}),
  });
  const nonce = crypto.randomUUID();
  const signature = await signInternal(key, {
    method: 'POST',
    path: '/run',
    timestampMs: nowMs,
    runId: req.runId,
    nonce,
    rawBody,
  });
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    'X-Internal-Timestamp': String(nowMs),
    'X-Internal-Run': req.runId,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': signature,
  };
  if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: ctrl.signal,
    });
    if (res.status === 202) return { ok: true };
    const body = /** @type {any} */ (await res.json().catch(() => null));
    return {
      ok: false,
      status: res.status,
      detail: String(body?.error ?? `HTTP ${res.status}`),
    };
  } catch (/** @type {any} */ e) {
    return { ok: false, status: 0, detail: `мозок недосяжний: ${String(e?.message ?? 'мережа')}` };
  } finally {
    clearTimeout(timer);
  }
}
