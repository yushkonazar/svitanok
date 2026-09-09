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

  await ensureMenuCollection(env, nowMs);
  const { items, fresh } = await findMenuNotes(env, { place, dish }, nowMs);

  if (fresh.length > 0) {
    return {
      result: {
        found: fresh.slice(0, MENU_HITS_MAX),
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
        found: [],
        // Протухлі знахідки показуємо чесно: це підказка, а не відповідь.
        stale: items.slice(0, MENU_HITS_MAX),
        source: 'collection',
        next: 'online',
      },
    };
  }

  const site = await siteOf(env, place, args.city, nowMs);
  return {
    result: {
      found: [],
      stale: items.slice(0, MENU_HITS_MAX),
      site: site.url,
      // ⚠️ Назву пише GOOGLE, тобто це чужий текст - у `<external>`, як і в
      // решті place-інструментів. Голим полем вона їхала б у контекст моделі
      // без позначки «дані, не команди».
      place: site.name ? wrapExternal('places', site.name) : null,
      // Немає сайту - немає чого читати Дослідникові; сказати про це прямо
      // краще, ніж відправляти його шукати навмання по всій мережі.
      next: site.url ? 'delegate' : 'no_site',
      collection: MENU_COLLECTION,
      fields: MENU_FIELDS.map((f) => f.name),
    },
  };
}

/**
 * Сайт закладу з довідника. Пошук за назвою, далі деталі (там і живе
 * `websiteUri`); обидва кроки йдуть через кеш `places`, тож повторне питання
 * про той самий заклад квоти не витрачає.
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
    url: httpUrl(details.place.site),
    name: details.place.name ?? first.name ?? null,
  };
}

/**
 * Лише http(s). ⚠️ Адресу пише Google, і це те, що ми далі даємо Дослідникові
 * відкривати: `javascript:` чи `data:` з зіпсованої картки не мають доїхати до
 * нього навіть як пропозиція.
 * @param {unknown} raw
 * @returns {string | null}
 */
function httpUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
