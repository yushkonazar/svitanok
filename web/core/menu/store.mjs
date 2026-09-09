// Меню закладів (ідея №3): «чи є в Креденсі сирники?».
//
// ⚠️ ЧОМУ ЦЕ ОКРЕМИЙ МОДУЛЬ, А НЕ ПРАВИЛО В ПЕРСОНІ. Порядок пошуку -
// «своя колекція → довідник → мережа» - має бути ДЕТЕРМІНОВАНИМ. Лишити його
// проханням у промпті означає, що модель час від часу піде одразу в мережу:
// це чотирихвилинний прогін Дослідника і витрачена квота Places на питання,
// відповідь на яке вже лежить у власній базі. Ядро говорить кодом.
//
// ⚠️ ЧОМУ КОЛЕКЦІЯ, А НЕ СВОЯ ТАБЛИЦЯ. Власник має бачити й правити ці
// знахідки тим самим способом, що й решту своїх записів (`/collections`,
// експорт у CSV, `records.update`). Своя таблиця дала б ще один формат, який
// власник не відкриє.

import { findCollection, RECORDS_LIST_MAX } from '../tools/collections.mjs';

/** Назва колекції. Фіксована: за нею ядро її й знаходить. */
export const MENU_COLLECTION = 'Меню закладів';

/**
 * Схема колекції. Поля навмисно рівно ті, що в погодженому плані ідеї №3:
 * заклад, місто, страва, ціна, джерело, дата перевірки.
 * @type {{ name: string, type: string, required?: boolean }[]}
 */
export const MENU_FIELDS = [
  { name: 'заклад', type: 'text', required: true },
  { name: 'місто', type: 'text' },
  { name: 'страва', type: 'text', required: true },
  { name: 'ціна', type: 'money' },
  { name: 'джерело', type: 'url' },
  { name: 'перевірено', type: 'date', required: true },
];

/**
 * Скільки днів знахідка вважається відповіддю, а не підказкою.
 *
 * ⚠️ Меню змінюється. Через три місяці «є сирники» - це вже не факт, а здогад,
 * і чесніше сходити в мережу заново, ніж упевнено переказати старе.
 */
export const MENU_FRESH_DAYS = 90;

const DAY_MS = 86_400_000;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * Створити колекцію, якщо її ще немає. Ідемпотентно.
 *
 * ⚠️ Повз policy навмисно: це не дія власника, а частина відповіді на його
 * питання - таких колекцій він не замовляв і «↩» на них не чекає. Той самий
 * прийом, що в ланцюга столика, який пише в `places` напряму.
 * @param {Env} env @param {number} nowMs
 * @returns {Promise<{ id: string, name: string }>}
 */
export async function ensureMenuCollection(env, nowMs) {
  const found = await findCollection(env, MENU_COLLECTION);
  if (found) return { id: found.id, name: found.name };
  const id = crypto.randomUUID();
  await db(env)
    .prepare(
      `INSERT OR IGNORE INTO collections (id, name, description, fields_json, sort_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      MENU_COLLECTION,
      'Страви, знайдені на сайтах закладів. Заповнюється сама, коли питаєш «чи є там X».',
      JSON.stringify(MENU_FIELDS),
      'перевірено',
      new Date(nowMs).toISOString(),
    )
    .run();
  // Гонку двох одночасних питань розвʼязує UNIQUE(name): перечитуємо.
  const after = await findCollection(env, MENU_COLLECTION);
  if (!after) throw new Error('колекцію меню не вдалось створити');
  return { id: after.id, name: after.name };
}

/**
 * FTS-запит за ОСНОВАМИ слів.
 *
 * ⚠️ НАВІЩО НЕ ПРОСТО ПРЕФІКС. Українська змінює закінчення, і префікс останнього
 * слова (як у `data.search`) тут не рятує: «в Креденсі» проти запису «Креденс» -
 * це не префікс, а інше слово. Тому кожне слово вкорочується на 1-2 літери й
 * шукається префіксом: «Креденсі» → `Креден*`, «сирник» → `сирн*`.
 *
 * Ціна - ширші збіги, але для власної невеликої колекції зайвий рядок дешевший
 * за пропущений: пропущений жене власника в мережу по відповідь, яка вже є.
 * @param {string} raw
 * @returns {string} порожньо, якщо слів немає
 */
function stemFtsQuery(raw) {
  const words = String(raw ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 1)
    .slice(0, 8);
  if (words.length === 0) return '';
  return words
    .map((w) => {
      const cut = w.length >= 6 ? 2 : w.length >= 5 ? 1 : 0;
      return `"${w.slice(0, w.length - cut)}"*`;
    })
    .join(' ');
}

/**
 * Знайти в колекції записи про страву в закладі.
 * @param {Env} env
 * @param {{ place: string, dish: string }} q
 * @param {number} nowMs
 * @returns {Promise<{ items: any[], fresh: any[] }>}
 */
export async function findMenuNotes(env, q, nowMs) {
  const col = await findCollection(env, MENU_COLLECTION);
  if (!col) return { items: [], fresh: [] };
  const match = stemFtsQuery(`${q.place} ${q.dish}`);
  if (!match) return { items: [], fresh: [] };
  const { results } = await db(env)
    .prepare(
      `SELECT r.data_json FROM records_fts f
       JOIN records r ON r.id = f.id
       WHERE records_fts MATCH ? AND r.collection_id = ?
       ORDER BY rank LIMIT ${RECORDS_LIST_MAX}`,
    )
    .bind(match, col.id)
    .all();
  const items = /** @type {any[]} */ (results ?? []).map((r) => {
    try {
      return JSON.parse(String(r.data_json));
    } catch {
      return {};
    }
  });
  const edge = nowMs - MENU_FRESH_DAYS * DAY_MS;
  const fresh = items.filter((it) => {
    const at = Date.parse(String(it?.['перевірено'] ?? ''));
    return Number.isFinite(at) && at >= edge;
  });
  return { items, fresh };
}
