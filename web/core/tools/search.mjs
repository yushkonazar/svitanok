// Пошук по ВЛАСНИХ даних одним запитом (релізний блок PR-7, §3.2).
//
// ПРОБЛЕМА, ЯКУ ЦЕ ЗАКРИВАЄ. «Коли я востаннє був у Креденсі» доти вимагало,
// щоб модель САМА здогадалась, куди дивитись: у місця, у транзакції, у
// колекції чи в ідеї. Помилка здогаду коштувала кроку прогону, а два-три
// пошуки поспіль - половини бюджету інструментів. Тут один виклик обходить
// усі джерела власника й віддає найкращі збіги з назвою джерела.
//
// ⚠️ ЧОГО ТУТ НЕМАЄ І ЧОМУ. Вхідні чати (`inbox.search`) не входять: цей
// інструмент tainting, і ЗАРАЗ будь-який пошук піднімав би рівень наступних
// дій назовні. Хто хоче чати - кличе inbox.search явно й свідомо. Памʼять
// розмов (`memory.search`) теж окремо: вона йде через Vectorize й Workers AI,
// тобто коштує вдвічі більше підзапитів, ніж усі D1-джерела разом.

import { ftsQuery } from './ideas.mjs';

/**
 * Той самий екран FTS, але з ПРЕФІКСНИМ збігом на останньому слові.
 *
 * ⚠️ Навіщо. Українська відмінює: «Креденс» у запиті проти «Креденсу» в тексті
 * ідеї - для FTS5 це різні токени, і точний пошук чесно нічого не знаходить.
 * Для ЦІЛЬОВОГО пошуку (`ideas.search`) це прийнятно - власник шукає те, що
 * писав. Тут же запит один на всі джерела, і промах через відмінок означав би
 * «нічого немає» там, де є. Зірочка ставиться лише на останнє слово: у
 * середині фрази вона розмиває пошук до сміття.
 * @param {string} q
 */
function prefixFtsQuery(q) {
  const exact = ftsQuery(q);
  if (!exact) return '';
  const parts = exact.split(' ');
  const last = parts.pop();
  return [...parts, `${last}*`].join(' ');
}

/** Скільки рядків максимум з КОЖНОГО джерела - щоб відповідь лишалась відповіддю. */
export const SEARCH_PER_SOURCE = 5;
/** Скільки джерел узагалі є; параметр `scopes` вибирає підмножину. */
export const SEARCH_SOURCES = ['ideas', 'records', 'places', 'money'];

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * data.search: один запит - усі власні джерела.
 * @param {Env} env
 * @param {{ q?: unknown, scopes?: unknown }} args
 * @returns {Promise<{ result: { hits: unknown[], searched: string[], failed: string[] } }>}
 */
export async function runDataSearch(env, args) {
  const q = String(args.q ?? '').trim();
  const match = prefixFtsQuery(q);
  if (!match) throw new Error('q має містити хоч одне слово');
  const asked = Array.isArray(args.scopes)
    ? args.scopes.map((s) => String(s ?? '').toLowerCase())
    : SEARCH_SOURCES;
  const scopes = SEARCH_SOURCES.filter((s) => asked.includes(s));
  if (scopes.length === 0) {
    throw new Error(`scopes: жодного відомого джерела; дозволені: ${SEARCH_SOURCES.join(', ')}`);
  }
  // ⚠️ Перевірка привʼязки - ДО циклу (ревʼю релізу): усередині вона падала б
  // у catch кожного скоупа й давала чотири рядки «джерело впало» замість
  // однієї чесної помилки «бази немає».
  db(env);

  /** @type {unknown[]} */
  const hits = [];
  /** @type {string[]} */
  const searched = [];
  /** @type {string[]} */
  const failed = [];
  for (const scope of scopes) {
    try {
      hits.push(...(await searchOne(env, scope, match, q)));
      searched.push(scope);
    } catch (/** @type {any} */ e) {
      // ⚠️ Одне джерело не сміє забрати відповідь: колекцій може не бути,
      // Mono - мовчати, FTS-індекс - відставати. Але й тиша неприпустима:
      // власник має бачити, де саме не шукали (той самий принцип, що «ЧОГО Я
      // НЕ БАЧИВ» у тижневому звіті).
      console.error(`data.search: джерело ${scope} впало`, e?.message);
      failed.push(scope);
    }
  }
  return { result: { hits, searched, failed } };
}

/** @param {Env} env @param {string} scope @param {string} match @param {string} q */
async function searchOne(env, scope, match, q) {
  if (scope === 'ideas') {
    const { results } = await db(env)
      .prepare(
        `SELECT i.id, i.number, i.title, i.status, i.updated_at
         FROM ideas_fts f JOIN ideas i ON i.id = f.id
         WHERE ideas_fts MATCH ? ORDER BY rank LIMIT ${SEARCH_PER_SOURCE}`,
      )
      .bind(match)
      .all();
    return (results ?? []).map((/** @type {any} */ r) => ({
      source: 'ideas',
      id: r.id,
      title: `#${r.number} ${r.title}`,
      at: r.updated_at,
      status: r.status,
    }));
  }
  if (scope === 'records') {
    const { results } = await db(env)
      .prepare(
        `SELECT r.id, r.data_json, r.updated_at, c.name AS collection FROM records_fts f
         JOIN records r ON r.id = f.id JOIN collections c ON c.id = r.collection_id
         WHERE records_fts MATCH ? ORDER BY rank LIMIT ${SEARCH_PER_SOURCE}`,
      )
      .bind(match)
      .all();
    return (results ?? []).map((/** @type {any} */ r) => ({
      source: 'records',
      id: r.id,
      collection: r.collection,
      title: firstValue(r.data_json),
      at: r.updated_at,
    }));
  }
  if (scope === 'places') {
    // Місця FTS не мають - шукаємо по назві й адресі підрядком. LIKE тут
    // дешевий: таблиця - кеш відвіданих місць, а не корпус.
    //
    // ⚠️ БЕЗ lower(): у SQLite і `lower()`, і нечутливість LIKE до регістру
    // працюють ЛИШЕ для ASCII. `lower('Креденс')` віддає «Креденс» як є, тож
    // приведення запиту до нижнього регістру гарантовано ламало б збіг для
    // кирилиці - рівно для тих даних, які тут і лежать. Тому підрядок беремо
    // як власник написав: ASCII LIKE однаково зіставить без регістру, а
    // кирилицю власник пише так само, як вона записана.
    const like = likePattern(q);
    const { results } = await db(env)
      .prepare(
        `SELECT place_id, name, address, visits, fetched_at FROM places
         WHERE name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\'
         ORDER BY visits DESC, fetched_at DESC LIMIT ${SEARCH_PER_SOURCE}`,
      )
      .bind(like, like)
      .all();
    return (results ?? []).map((/** @type {any} */ r) => ({
      source: 'places',
      id: r.place_id,
      title: r.name,
      address: r.address,
      visits: r.visits,
      at: r.fetched_at,
    }));
  }
  // money: опис мерчанта - зовнішній текст, але він уже нормалізований при
  // записі (finance/store.mjs), тож tainting тут не потрібен.
  const like = likePattern(q); // без lower() - див. коментар про кирилицю вище
  const { results } = await db(env)
    .prepare(
      `SELECT id, description, amount, currency, amount_uah, at FROM transactions
       WHERE description LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ${SEARCH_PER_SOURCE}`,
    )
    .bind(like)
    .all();
  return (results ?? []).map((/** @type {any} */ r) => ({
    source: 'money',
    id: r.id,
    title: r.description,
    amount: r.amount_uah ?? r.amount,
    currency: r.amount_uah == null ? r.currency : 'UAH',
    at: r.at,
  }));
}

/**
 * Підрядок для LIKE з екранованими `%` і `_`.
 * ⚠️ Не інʼєкція (значення звʼязане), але без цього запит «50%» тихо
 * розширювався до «50 і будь-що» - тобто результат ширший за питання.
 * Екран - зворотний слеш, і саме він оголошений в ESCAPE кожного запиту.
 * @param {string} q
 */
function likePattern(q) {
  const esc = String.fromCharCode(92);
  return `%${q.replace(/[\\%_]/g, (c) => esc + c)}%`;
}

/** Перше непорожнє значення запису - підпис для власника. @param {unknown} raw */
function firstValue(raw) {
  try {
    const data = JSON.parse(String(raw ?? '{}'));
    for (const v of Object.values(data)) {
      const s = String(v ?? '').trim();
      if (s) return s.slice(0, 80);
    }
  } catch {
    // побитий JSON - підпису немає, але сам рядок знайдено
  }
  return '(без назви)';
}
