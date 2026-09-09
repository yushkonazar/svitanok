// places.menu (ідея №3): «чи є в Креденсі сирники?».
//
// ⚠️ ПОРЯДОК ЖОРСТКИЙ І НАЛЕЖИТЬ ЯДРУ: своя колекція → довідник → мережа.
// Перший крок безкоштовний і НЕ плямує сесію; у мережу інструмент іде лише
// тоді, коли його покликали вдруге з `online: true`. Через це питання, на яке
// відповідь уже є, не коштує ні квоти Places, ні чотирихвилинного прогону
// Дослідника, ні ✅ на наступну дію власника (taint живе 10 хв).
//
// Записує знахідку НЕ цей інструмент, а модель через `records.create`: у
// відповіді є і назва колекції, і перелік полів, тож вигадувати їй нічого.

import { placesSearch, placeDetails } from '../adapters/maps.mjs';
import { wrapExternal } from './markup.mjs';
import { safeHttpUrl } from './url.mjs';
import {
  ensureMenuCollection,
  findMenuNotes,
  MENU_COLLECTION,
  MENU_FIELDS,
} from '../menu/store.mjs';

/** Скільки знахідок віддавати моделі: більше - це вже не відповідь, а дамп. */
const MENU_HITS_MAX = 5;

/**
 * @param {Env} env
 * @param {{ place?: string, dish?: string, city?: string, online?: boolean }} args
 * @param {number} nowMs
 */
export async function runPlacesMenu(env, args, nowMs) {
  const place = String(args.place ?? '').trim();
  const dish = String(args.dish ?? '').trim();
  if (!place) throw new Error('place обовʼязковий - назва закладу');
  if (!dish) throw new Error('dish обовʼязкова - що саме шукаємо в меню');

  // ⚠️ Колекцію НЕ створюємо на читанні (ревʼю): `findMenuNotes` без неї просто
  // віддає порожньо, а створення повз policy на кожне питання означало б, що
  // видалену власником колекцію (це T2 - ✅ і слово) безшумно відроджує будь-яке
  // наступне «чи є там X».
  const { items, fresh } = await findMenuNotes(env, { place, dish }, nowMs);

  if (fresh.length > 0) {
    return {
      result: {
        found: menuLines(fresh),
        found_count: Math.min(fresh.length, MENU_HITS_MAX),
        source: 'collection',
        next: 'answer',
      },
    };
  }

  if (args.online !== true) {
    // ⚠️ Друга дія - окремим викликом, а не тут: саме вона плямує сесію, і
    // платити цим за питання з кешу було б неправильно.
    return {
      result: {
        found_count: 0,
        // Протухлі знахідки показуємо чесно: це підказка, а не відповідь.
        stale: menuLines(items),
        stale_count: Math.min(items.length, MENU_HITS_MAX),
        source: 'collection',
        next: 'online',
      },
    };
  }

  await ensureMenuCollection(env, nowMs);
  const site = await siteOf(env, place, args.city, nowMs);
  return {
    result: {
      found_count: 0,
      stale: menuLines(items),
      stale_count: Math.min(items.length, MENU_HITS_MAX),
      site: site.url,
      // ⚠️ Назву пише GOOGLE, тобто це чужий текст - у `<external>`, як і в
      // решті place-інструментів. Голим полем вона їхала б у контекст моделі
      // без позначки «дані, не команди».
      place: site.name ? wrapExternal('places', site.name) : null,
      // Немає сайту - немає чого читати Дослідникові; сказати про це прямо
      // краще, ніж відправляти його шукати навмання по всій мережі.
      next: site.url ? 'delegate' : 'no_site',
      collection: MENU_COLLECTION,
      // ⚠️ Типи й обовʼязковість, а не самі імена (ревʼю): `coerceValue`
      // валідує суворо, і без цього модель писала «85-120 грн» у поле money,
      // голий домен у поле url або забувала дату - `records.create` падав, і
      // знахідка не кешувалась. Тобто мета «щоб удруге не шукати» не досягалась.
      fields: MENU_FIELDS,
    },
  };
}

/**
 * Знахідки одним зовнішнім блоком.
 *
 * ⚠️ `<external>` тут ОБОВʼЯЗКОВИЙ (security-ревʼю). Вміст цих записів колись
 * приїхав зі сторінки закладу через Дослідника: він був плямований і
 * загорнутий, а `records.create` (T0) поклав його у власну базу. Без обгортки
 * наступна - уже ЧИСТА - сесія дістала б чужий текст як довірений, і колекція
 * стала б каналом, яким інʼєкція знімає з себе позначку.
 * @param {any[]} rows
 */
function menuLines(rows) {
  const lines = rows.slice(0, MENU_HITS_MAX).map((r) => {
    const parts = [r['заклад'], r['місто'], r['страва'], r['ціна']]
      .filter((x) => x != null && String(x) !== '')
      .map(String);
    return `${parts.join(' · ')} · перевірено ${r['перевірено'] ?? '?'}${r['джерело'] ? ` · ${r['джерело']}` : ''}`;
  });
  return lines.length ? wrapExternal('collection:menu', lines.join('\n')) : null;
}

/**
 * Сайт закладу з довідника. Пошук за назвою, далі деталі (там і живе
 * `websiteUri`).
 *
 * ⚠️ Кеш тут НЕ безкоштовний (ревʼю): `placesSearch` читає таблицю `places`
 * лише коли квоту вже вичерпано, тож кожен `online: true` коштує одиницю
 * `places_text`; деталі кешуються на 7 днів і повторне питання про той самий
 * заклад справді дешевше, але пошук - ні.
 * @param {Env} env @param {string} place @param {unknown} city @param {number} nowMs
 * @returns {Promise<{ url: string | null, name: string | null }>}
 */
async function siteOf(env, place, city, nowMs) {
  const found = await placesSearch(
    env,
    { query: place, city: city == null ? undefined : String(city), limit: 1 },
    nowMs,
  );
  const first = found.places?.[0];
  if (!first) return { url: null, name: null };
  const details = await placeDetails(env, first.place_id, nowMs);
  return {
    url: safeHttpUrl(details.place.site),
    name: details.place.name ?? first.name ?? null,
  };
}
