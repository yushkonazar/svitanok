// GET /api/archive — читання холодного архіву місячних згорток.
//
// ⚠️ ОКРЕМИЙ ЕНДПОІНТ, а не поле в /api/stats. Той крутить aggregateStats на
// КОЖЕН запит у бюджеті 10 мс CPU (і ми щойно виграли там 3.4 мс), тож додати
// туди ще одне KV-читання заради даних, потрібних лише коли людина відкриє
// «Історію», означало б платити цю ціну на кожному відкритті дашборда.
//
// ⚠️ ПРИВАТНИЙ, на відміну від /api/status. Там — одна мітка «сервіс живий»;
// тут — середні по сну, енергії й настрою за роки, тобто щоденник. Той самий
// auth, що й решта читань дашборда, і жодних CORS-заголовків.

import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import { ARCHIVE_KEY } from './stats-archive.mjs';

/** 'YYYY-MM' і нічого іншого — ключі архіву пише крон, але читаємо ми строго. */
const isMonthKey = (/** @type {unknown} */ k) =>
  typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);

/**
 * Архів -> {months:[{month, ...згортка}]}, хронологічно.
 *
 * Масив, а не мапа: споживач малює ряд, тобто порядок — частина відповіді, і
 * покладатись тут на порядок ключів обʼєкта не можна (та сама причина, з якої
 * тренд оцінок mock свого часу не можна було побудувати).
 *
 * Биті дані зводяться до порожнього списку, а не до 500: архів дописується
 * кроном, і зіпсований запис не має валити екран — блок просто не покажеться.
 * @param {Env} env
 * Тип auth — МІНІМУМ, який тут справді читається, а не повний AuthResult:
 * функція лише гейтить за `ok` і віддає `status`/`error` назад. Вимагати
 * повну ухвалу означало б, що фікстура дописує `user` заради типу.
 * @param {{ ok?: unknown, status?: number, error?: string }|null|undefined} auth
 */
export async function handleArchive(env, auth) {
  if (!auth?.ok) return json({ ok: false, error: auth?.error ?? 'auth' }, auth?.status ?? 401);
  /** @type {KvBlob[]} */
  let months = [];
  try {
    const raw = await env.BRIEFING.get(ARCHIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      months = Object.entries(parsed)
        .filter(([k, v]) => isMonthKey(k) && v && typeof v === 'object')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, ...v }));
    }
  } catch {
    months = [];
  }
  // no-store: приватне й читається рідко, тож кешувати нема сенсу — а
  // публічний кеш тут був би прямою помилкою.
  return new Response(JSON.stringify({ months }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Обгортка з auth для маршруту воркера.
 *  @param {Request} request
 *  @param {Env} env */
export async function handleArchiveRequest(request, env) {
  return handleArchive(env, await checkOwnerRead(request, env));
}
