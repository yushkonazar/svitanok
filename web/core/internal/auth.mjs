// Автентифікація internal API (07-schema §3, 01-architecture §4.4): кожен
// запит /internal/* несе часову мітку, run_id і HMAC-підпис тіла. Це другий
// шар за Cloudflare Access (service token перевіряє межа Cloudflare) — HMAC
// доводить, що викликач знає спільний ключ, ТТL рубає реплей, run_id
// привʼязує виклик до живого прогону в RunRegistry (перевіряє router).
//
// Контракт підпису (мозок підписує так само, етап 2):
//   X-Internal-Timestamp: unix-мс, рядок
//   X-Internal-Run:       run_id прогону
//   X-Internal-Signature: hex HMAC-SHA256(key, `${timestamp}.${runId}.${rawBody}`)
//
// Ключі: INTERNAL_HMAC_KEY і, у вікні ротації, INTERNAL_HMAC_KEY_NEXT -
// двоключова ротація з 05-ops §3 (ядро приймає старий і новий 24 год).

import { constantTimeEqual } from '../../tg-core.mjs';

/** TTL підпису: 10 хв в ОБИДВА боки (04 §3 «TTL 10 хв»; модуль — бо клок-скью
 *  між VPS і Cloudflare може хилитись будь-куди). */
export const INTERNAL_SIG_TTL_MS = 10 * 60_000;

/** Та сама пара importKey/sign, що в auth-core.mjs. Свідомо НЕ реекспорт
 *  звідти: internal-шар не має залежати від Telegram-модуля заради 7 рядків. */
async function hmacHex(/** @type {string} */ key, /** @type {string} */ msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Підписати запит (тести зараз; ядро→мозок — етап 2).
 * @param {string} key
 * @param {number} timestampMs
 * @param {string} runId
 * @param {string} rawBody
 */
export async function signInternal(key, timestampMs, runId, rawBody) {
  return hmacHex(key, `${timestampMs}.${runId}.${rawBody}`);
}

/**
 * Чинні ключі HMAC. Trim — задокументована пастка проєкту (хвостовий \r\n із
 * панелі); рядок із самих пробілів = незаданий ключ (та сама семантика, що
 * validateInitData). Порожній список — fail-closed: 500, не тихий пропуск.
 * @param {Env} env
 */
function hmacKeys(env) {
  return [env.INTERNAL_HMAC_KEY, env.INTERNAL_HMAC_KEY_NEXT]
    .map((k) => String(k ?? '').trim())
    .filter(Boolean);
}

/**
 * Перевірити підпис запиту. Повертає `{ ok: true, runId }` або
 * `{ ok: false, status, error }` — router перетворює на відповідь як є.
 * Порядок перевірок фіксований і дешевий → дорогий: заголовки → TTL → HMAC;
 * звірка HMAC константночасна (звіряємо секрет, не дані).
 * @param {{ headers: Headers, bodyText: string, nowMs: number, env: Env }} req
 * @returns {Promise<{ ok: true, runId: string } | { ok: false, status: number, error: string }>}
 */
export async function verifyInternalRequest({ headers, bodyText, nowMs, env }) {
  const keys = hmacKeys(env);
  if (keys.length === 0) {
    // Misconfig не сміє виглядати як «невірний підпис» (401 клієнт лікував би
    // ротацією ключа) — це 500 і явний текст.
    return { ok: false, status: 500, error: 'hmac-not-configured' };
  }

  const tsRaw = headers.get('X-Internal-Timestamp');
  const runId = headers.get('X-Internal-Run');
  const signature = headers.get('X-Internal-Signature');
  if (!tsRaw || !runId || !signature) return { ok: false, status: 401, error: 'missing-auth' };

  const timestampMs = Number(tsRaw);
  if (!Number.isFinite(timestampMs)) return { ok: false, status: 401, error: 'bad-timestamp' };
  if (Math.abs(nowMs - timestampMs) > INTERNAL_SIG_TTL_MS) {
    return { ok: false, status: 401, error: 'stale-timestamp' };
  }

  for (const key of keys) {
    const expected = await hmacHex(key, `${timestampMs}.${runId}.${bodyText}`);
    if (constantTimeEqual(expected, signature)) return { ok: true, runId };
  }
  return { ok: false, status: 401, error: 'bad-signature' };
}
