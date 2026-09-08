// «Забудь усе» (S-0-5 «чат X / колекція Y / усе», 07 §4 `forget`, T2 зі
// словом; етап 7 PR-4).
//
// ⚠️ ЩО САМЕ СТИРАЄТЬСЯ - СПИСОК ДАНИМИ, не гілки коду: інакше нова таблиця
// тихо переживе «забудь усе», і власник вважатиме стертим те, що лишилось.
// Контракт-тест звіряє список зі знімком бекапу (BACKUP_TABLES).
//
// ЩО НЕ СТИРАЄТЬСЯ І ЧОМУ.
//   `instructions` / `instruction_history` - це НЕ дані власника, а конфіг
//   застосунку з репозиторію (ADR-016): стерши їх, ми зупинили б асистента до
//   наступної синхронізації, і «забудь усе» перетворилось би на «вимкни».
//   `migrations_meta` - службовий журнал схеми; без нього наступна міграція
//   пішла б заново.
//   KV: `state` цілком не чіпаємо - у ньому живе робоче листування з
//   Telegram (lastUpdateId, адреси вебхука, мітки задач), і його обнулення
//   зламало б бота, а не забуло б власника. Стираються ПОЛЯ даних усередині
//   нього і власні ключі даних (перелік нижче).

import { BACKUP_TABLES } from '../backup/core.mjs';

/**
 * Таблиці, які «забудь усе» НЕ чіпає, і чому.
 *   instructions / instruction_history - конфіг застосунку з репозиторію
 *     (ADR-016): без персони прогін не стартує, і «забудь усе» стало б
 *     «вимкни асистента».
 *   counters - службовий лічильник номерів ідей (міграція 0011). ⚠️ DELETE
 *     звідти прибирає САМ РЯДОК, і `ideas.create` після цього назавжди падає
 *     з «лічильник ideas відсутній - міграція 0011 не застосована»: власник
 *     дістав би брехливу помилку про міграцію й непрацездатні ідеї. Рядок
 *     лишається, а значення обнуляється (нижче) - нумерація починається з
 *     нуля, як і має бути після забуття.
 */
export const FORGET_ALL_KEEP = ['instructions', 'instruction_history', 'counters'];

/** Таблиці, які «забудь усе» очищає. */
export const FORGET_ALL_TABLES = BACKUP_TABLES.filter((t) => !FORGET_ALL_KEEP.includes(t));

/** FTS-індекси (ADR-036 standalone): чистяться окремо, інакше пошук ще довго
 *  знаходив би стерте. */
export const FORGET_ALL_FTS = ['ideas_fts', 'records_fts', 'inbox_fts'];

/**
 * Власні KV-ключі даних - зникають цілком. Список звіряється тестом із
 * переліком ключів, які проєкт узагалі пише: інакше «стерто все» лишало б
 * позаду те, чого ніхто не помітив, - як от координати власника
 * (`ownerGeo`), що переживали стирання й далі відповідали на «де я».
 */
export const FORGET_ALL_KV_KEYS = [
  'stats',
  'statsArchive',
  'statsArchiveWeekly',
  'saved',
  'levers',
  'latest',
  'assistantHistory',
  'ownerGeo',
  'ownerGeoManual',
  'weatherLive',
  'assistantPending',
];

/**
 * ⚠️ ЩО СЮДИ НЕ ПОТРАПИЛО І ЧОМУ (ревʼю виправлень).
 *   `sentMessages` - ring-buffer id повідомлень бота для `/clear`. Стерши
 *     його, «забудь усе» прибрало б ЄДИНИЙ інструмент прибирання: старі
 *     повідомлення лишились би в чаті назавжди.
 *   `backupState` - мітка «бекап цієї неділі зроблено». Без неї найближчий
 *     тік після 04:00 вирішив би, що бекап не відбувся, і послав алерт про
 *     неіснуючий збій (а до 04:00 - зробив би другий бекап).
 *   `monoReconcile` - крок звірки з банком; його скидання запустило б
 *     повторне первинне завантаження за 31 добу.
 * Усі три - службовий стан, а не дані власника.
 */

/** Поля даних усередині блоба `state` (сам ключ лишається живим). */
export const FORGET_ALL_STATE_FIELDS = [
  'reminders',
  'shownMail',
  'shownNews',
  'shownJobs',
  'mailTriage',
  'calendarToday',
  'roadmapProgress',
];

/**
 * Стерти все. Повертає підрахунок для рядка «Стерто: …».
 * @param {Env} env
 * @returns {Promise<{ tables: number, rows: number, kvKeys: number }>}
 */
export async function forgetAll(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - стирання неможливе');
  const db = env.DB;
  let rows = 0;
  for (const table of FORGET_ALL_TABLES) {
    // Імена - з константного списку, не з вводу.
    const res = await db.prepare(`DELETE FROM ${table}`).bind().run();
    rows += Number(res?.meta?.changes ?? 0);
  }
  // Лічильники не видаляємо, а обнуляємо: рядок потрібен коду, значення - ні.
  await db
    .prepare('UPDATE counters SET value = 0')
    .bind()
    .run()
    .catch((/** @type {any} */ e) => {
      console.error('forget: лічильники не обнулено', e?.message);
    });
  for (const fts of FORGET_ALL_FTS) {
    // Індекс міг не існувати на старій базі - його відсутність не привід
    // лишити стерті рядки «наполовину стертими».
    await db
      .prepare(`DELETE FROM ${fts}`)
      .bind()
      .run()
      .catch((/** @type {any} */ e) => {
        console.error(`forget: індекс ${fts} не очищено`, e?.message);
      });
  }

  let kvKeys = 0;
  for (const key of FORGET_ALL_KV_KEYS) {
    try {
      if ((await env.BRIEFING.get(key)) != null) {
        await env.BRIEFING.delete(key);
        kvKeys += 1;
      }
    } catch (/** @type {any} */ e) {
      console.error(`forget: ключ ${key} не стерто`, e?.message);
    }
  }
  await clearStateFields(env);
  return { tables: FORGET_ALL_TABLES.length, rows, kvKeys };
}

/** @param {Env} env */
async function clearStateFields(env) {
  const raw = (await env.BRIEFING.get('state')) ?? '{}';
  /** @type {Record<string, unknown>} */
  let blob;
  try {
    blob = JSON.parse(raw);
  } catch {
    return; // побитий блоб - не наша справа тут
  }
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return;
  let touched = false;
  for (const field of FORGET_ALL_STATE_FIELDS) {
    if (field in blob) {
      delete blob[field];
      touched = true;
    }
  }
  if (touched) await env.BRIEFING.put('state', JSON.stringify(blob));
}
