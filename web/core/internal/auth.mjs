// Автентифікація internal API (07-schema §3, 01-architecture §4.4): кожен
// запит /internal/* несе часову мітку, run_id, nonce і HMAC-підпис. Це другий
// шар за Cloudflare Access (service token перевіряє межа Cloudflare) — HMAC
// доводить знання спільного ключа, TTL обмежує вікно, nonce рубає реплей у
// межах вікна, run_id привʼязує виклик до живого прогону (перевіряє router).
//
// Контракт підпису (мозок підписує так само, етап 2):
//   X-Internal-Timestamp: unix-мс, рядок
//   X-Internal-Run:       run_id прогону
//   X-Internal-Nonce:     унікальний на запит (uuid); ядро споживає його
//                         в RunRegistry - повтор у вікні TTL відкидається
//   X-Internal-Signature: hex HMAC-SHA256(key, повідомлення нижче)
//
// Повідомлення підпису: `${method}\n${path}\n${ts}\n${runId}\n${nonce}\n${body}`.
// МЕТОД І ШЛЯХ УСЕРЕДИНІ ПІДПИСУ - не церемонія: без них підписаний
// /internal/status переносився б на /internal/deliver з тим самим тілом
// (обидва контракти - {text}), і статусний рядок ставав би доставленим
// повідомленням. Розділювач \n однозначний: у шляху й заголовках \n не буває.
//
// Ключі: INTERNAL_HMAC_KEY і, у вікні ротації, INTERNAL_HMAC_KEY_NEXT -
// двоключова ротація з 05-ops §3 (ядро приймає старий і новий 24 год).

import { constantTimeEqual } from '../../tg-core.mjs';

/** TTL підпису: 10 хв в ОБИДВА боки (07 §3 «TTL 10 хв»; модуль — бо клок-скью
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
 * @typedef {{ method: string, path: string, timestampMs: number, runId: string,
 *   nonce: string, rawBody: string }} InternalSignInput
 */

/**
 * Підписати запит (тести зараз; ядро→мозок і мозок→ядро — етап 2).
 * @param {string} key
 * @param {InternalSignInput} input
 */
export async function signInternal(key, { method, path, timestampMs, runId, nonce, rawBody }) {
  return hmacHex(key, `${method}\n${path}\n${timestampMs}\n${runId}\n${nonce}\n${rawBody}`);
}

/**
 * Заголовки підписаного запиту в internal API (ядро→мозок /run і /abort;
 * Actions→ядро /internal/artifact): X-Internal-* + Access-пара, коли вона є.
 * Один збирач на всіх, хто підписує з боку web/ (ревʼю етапу 4 PR-1: третя
 * копія заголовків розʼїхалась би з першими двома так само тихо, як і підпис).
 * @param {string} key
 * @param {{ method: string, path: string, runId: string, rawBody: string, nowMs: number,
 *   nonce?: string, access?: { clientId: string, clientSecret: string } | null }} req
 * @returns {Promise<Record<string, string>>}
 */
export async function signedInternalHeaders(key, req) {
  const nonce = req.nonce ?? crypto.randomUUID();
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    'X-Internal-Timestamp': String(req.nowMs),
    'X-Internal-Run': req.runId,
    'X-Internal-Nonce': nonce,
    'X-Internal-Signature': await signInternal(key, {
      method: req.method,
      path: req.path,
      timestampMs: req.nowMs,
      runId: req.runId,
      nonce,
      rawBody: req.rawBody,
    }),
  };
  if (req.access) {
    headers['CF-Access-Client-Id'] = req.access.clientId;
    headers['CF-Access-Client-Secret'] = req.access.clientSecret;
  }
  return headers;
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
 * Перевірити підпис запиту. Повертає `{ ok: true, runId, nonce }` або
 * `{ ok: false, status, error }` — router перетворює на відповідь як є.
 * Порядок перевірок фіксований і дешевий → дорогий: заголовки → TTL → HMAC;
 * звірка HMAC константночасна (звіряємо секрет, не дані). Споживання nonce —
 * справа викликача (router → RunRegistry), тут лише його участь у підписі.
 * @param {{ method: string, path: string, headers: Headers, bodyText: string,
 *   nowMs: number, env: Env }} req
 * @returns {Promise<{ ok: true, runId: string, nonce: string }
 *   | { ok: false, status: number, error: string }>}
 */
export async function verifyInternalRequest({ method, path, headers, bodyText, nowMs, env }) {
  const keys = hmacKeys(env);
  if (keys.length === 0) {
    // Misconfig не сміє виглядати як «невірний підпис» (401 клієнт лікував би
    // ротацією ключа) — це 500 і явний текст.
    return { ok: false, status: 500, error: 'hmac-not-configured' };
  }

  const tsRaw = headers.get('X-Internal-Timestamp');
  const runId = headers.get('X-Internal-Run');
  const nonce = headers.get('X-Internal-Nonce');
  const signature = headers.get('X-Internal-Signature');
  if (!tsRaw || !runId || !nonce || !signature) {
    return { ok: false, status: 401, error: 'missing-auth' };
  }

  const timestampMs = Number(tsRaw);
  if (!Number.isFinite(timestampMs)) return { ok: false, status: 401, error: 'bad-timestamp' };
  if (Math.abs(nowMs - timestampMs) > INTERNAL_SIG_TTL_MS) {
    return { ok: false, status: 401, error: 'stale-timestamp' };
  }

  for (const key of keys) {
    const expected = await signInternal(key, {
      method,
      path,
      timestampMs,
      runId,
      nonce,
      rawBody: bodyText,
    });
    if (constantTimeEqual(expected, signature)) return { ok: true, runId, nonce };
  }
  return { ok: false, status: 401, error: 'bad-signature' };
}
