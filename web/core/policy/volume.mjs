// Скільки саме буде стерто - ДО того, як власник напише слово (релізний блок
// PR-2, A2 прогону 08.09: «T2 не каже обсягу»).
//
// ⚠️ ЧОМУ ЦЕ ВАЖЛИВО. T2 - незворотне. «Стерти все?» і «Стерти 1 240
// повідомлень, 86 записів і 12 ідей?» - це два різні рішення, і власник має
// право ухвалювати друге. Рахунок робиться SELECT COUNT, тобто нічого не
// змінює: якщо він упав, пропозиція однаково лишається чинною - без числа,
// але без числа краще, ніж без пропозиції.

import { plural } from '../tg/phrase.mjs';
import { FORGET_ALL_TABLES, FORGET_ALL_KV_KEYS } from '../export/forget-all.mjs';
import { resolveChats } from '../inbox/store.mjs';
import { findCollection } from '../tools/collections.mjs';

/** @param {Env} env */
const db = (env) => {
  if (!env.DB) throw new Error('D1 не привʼязана');
  return env.DB;
};

/** @param {Env} env @param {string} sql @param {unknown[]} args */
async function count(env, sql, args = []) {
  const row = /** @type {any} */ (
    await db(env)
      .prepare(sql)
      .bind(...args)
      .first()
  );
  return Number(row?.n) || 0;
}

/**
 * Людський опис обсягу T2-дії, або порожній рядок - коли рахувати нема чого
 * (ціна відео вже стоїть у пропозиції) або коли рахунок не вдався.
 * @param {Env} env
 * @param {string} kind
 * @param {Record<string, unknown> | undefined} payload
 * @returns {Promise<string>}
 */
export async function proposalVolume(env, kind, payload) {
  const p = /** @type {Record<string, unknown>} */ (payload ?? {});
  try {
    if (kind === 'forget') return await forgetVolume(env, p);
    if (kind === 'data.export') {
      // Точний розмір архіву відомий лише після збірки, а збирати двічі -
      // палити CPU й памʼять. Чесно називаємо ОХОПЛЕННЯ, не розмір.
      return `усі твої дані з ${FORGET_ALL_TABLES.length} таблиць і ${FORGET_ALL_KV_KEYS.length} ключів KV`;
    }
    return '';
  } catch (/** @type {any} */ e) {
    // Пропозиція важливіша за число: без обсягу власник ще може вирішити, без
    // пропозиції - ні.
    console.error(`policy: обсяг для ${kind} не порахувався`, e?.message);
    return '';
  }
}

/** @param {Env} env @param {Record<string, unknown>} payload */
async function forgetVolume(env, payload) {
  const target = String(payload.target ?? (payload.collection != null ? 'collection' : ''));
  if (target === 'collection') {
    const col = await findCollection(env, payload.collection ?? payload.id);
    if (!col) return '';
    const n = await count(env, 'SELECT COUNT(*) AS n FROM records WHERE collection_id = ?', [
      col.id,
    ]);
    return `${n} ${plural(n, 'запис', 'записи', 'записів')} у колекції «${col.name}»`;
  }
  if (target === 'chat') {
    const { ids } = await resolveChats(env, String(payload.chat ?? payload.name ?? ''));
    if (!ids.length) return '';
    const marks = ids.map(() => '?').join(', ');
    const messages = await count(
      env,
      `SELECT COUNT(*) AS n FROM inbox_messages WHERE chat_id IN (${marks})`,
      ids,
    );
    return `${messages} ${plural(messages, 'повідомлення', 'повідомлення', 'повідомлень')}`;
  }
  if (target === 'all') {
    // Один запит на таблицю - їх десятки, тож рахунок іде UNION ALL однією
    // підготовленою вибіркою: 50 підзапитів Worker'а тут ділити ні з ким.
    const sql = FORGET_ALL_TABLES.map((t) => `SELECT COUNT(*) AS n FROM ${t}`).join(' UNION ALL ');
    const { results } = await db(env).prepare(sql).bind().all();
    const rows = (results ?? []).reduce(
      (/** @type {number} */ acc, /** @type {any} */ r) => acc + (Number(r?.n) || 0),
      0,
    );
    return `${rows} ${plural(rows, 'рядок', 'рядки', 'рядків')} у ${FORGET_ALL_TABLES.length} таблицях і ${FORGET_ALL_KV_KEYS.length} ${plural(FORGET_ALL_KV_KEYS.length, 'ключ', 'ключі', 'ключів')} KV`;
  }
  return '';
}
