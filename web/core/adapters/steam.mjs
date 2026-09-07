// Steam + IsThereAnyDeal (01 §2.4 «адаптери», S-5-1…S-5-4, етап 5 PR-5).
// Ціни знижок беремо в ITAD (він знає й історичний мінімум, і всі магазини),
// назви/appid - у публічному Store API Steam. Обидва - без квоти в
// `quota_counters`: у ITAD безкоштовний ключ без денної стелі, у Steam -
// неавторизований store-API; на день виходить один батч-виклик кожного.
//
// Гроші - у мінімальних одиницях (копійках): Steam віддає `final` уже в них,
// ITAD - `amountInt`. Жодних дробів у базі (07 §1).

const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const STEAM_APPDETAILS = 'https://store.steampowered.com/api/appdetails';
const STEAM_WISHLIST = 'https://api.steampowered.com/IWishlistService/GetWishlist/v1';
const ITAD_LOOKUP = 'https://api.isthereanydeal.com/games/lookup/v1';
const ITAD_PRICES = 'https://api.isthereanydeal.com/games/prices/v3';

const TIMEOUT_MS = 12_000;
/** Стеля тіла відповіді: більше - це вже не ціни, а щось не те. */
const BODY_MAX = 2_000_000;
/** Валюта - рівно три великі літери (далі вона йде у formatMoney і в чат). */
const CURRENCY_RE = /^[A-Z]{3}$/;
/** Стеля довжини URL пропозиції (та сама, що в price_points у price.mjs). */
const URL_MAX = 500;
/** Країна цін і мова назв (власник у Києві). */
export const COUNTRY = 'UA';
const LANG = 'ukrainian';
/** Стеля батча ITAD (документація: 1-200 id). */
export const ITAD_BATCH_MAX = 200;
/** Скільки appid за раз просимо в Steam: довший рядок магазин ріже сам. */
export const STEAM_BATCH_MAX = 50;

/** @param {Env} env */
export function itadApiKey(env) {
  const key = String(env.ITAD_API_KEY ?? '').trim();
  if (!key) throw new Error('ITAD_API_KEY не заданий - знижки недоступні');
  return key;
}

/**
 * Запит JSON із таймаутом. Текст помилки НЕ несе ані URL, ані ключа - лише
 * сервіс і статус (правило секретів).
 * @param {string} url @param {RequestInit} init @param {string} who
 */
async function callJson(url, init, who) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (/** @type {any} */ e) {
    throw new Error(`${who}: запит не пройшов (${String(e?.name ?? 'error')})`, { cause: e });
  }
  if (!res.ok) throw new Error(`${who}: HTTP ${res.status}`);
  const text = await res.text();
  // Розбір гігантської відповіді зʼїв би памʼять ізоляту - краще гучна межа.
  if (text.length > BODY_MAX) throw new Error(`${who}: відповідь понад ${BODY_MAX} байтів`);
  try {
    return /** @type {any} */ (JSON.parse(text));
  } catch (/** @type {any} */ e) {
    throw new Error(`${who}: відповідь не JSON`, { cause: e });
  }
}

// ── Steam ──────────────────────────────────────────────────────────────────

/**
 * Пошук гри в магазині Steam (S-5-1: «хочу гру Hades II» → appid і ціна).
 * @param {string} query @param {number} [limit]
 * @returns {Promise<{ appid: number, name: string, price_minor: number | null, currency: string | null }[]>}
 */
export async function steamSearch(query, limit = 5) {
  const term = String(query ?? '').trim();
  if (!term) throw new Error('steam: порожній запит');
  const url = new URL(STEAM_SEARCH);
  url.searchParams.set('term', term.slice(0, 120));
  url.searchParams.set('cc', COUNTRY);
  url.searchParams.set('l', LANG);
  const json = await callJson(url.toString(), {}, 'Steam');
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.slice(0, Math.max(1, Math.min(10, limit))).map((/** @type {any} */ it) => ({
    appid: Number(it?.id),
    name: String(it?.name ?? '').slice(0, 200),
    price_minor: Number.isFinite(Number(it?.price?.final)) ? Number(it.price.final) : null,
    currency: it?.price?.currency ? String(it.price.currency) : null,
  }));
}

/**
 * Ціни й назви за appid (батчем). `filters=price_overview` не віддає назву,
 * тож назву беремо лише коли просять (`withName`) - це другий виклик.
 * @param {number[]} appids @param {{ withName?: boolean }} [opts]
 * @returns {Promise<Map<number, { name: string | null, price_minor: number | null, initial_minor: number | null, discount: number, currency: string | null }>>}
 */
export async function steamAppDetails(appids, opts = {}) {
  /** @type {Map<number, any>} */
  const out = new Map();
  const ids = [...new Set(appids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  for (let i = 0; i < ids.length; i += STEAM_BATCH_MAX) {
    const chunk = ids.slice(i, i + STEAM_BATCH_MAX);
    const url = new URL(STEAM_APPDETAILS);
    url.searchParams.set('appids', chunk.join(','));
    url.searchParams.set('cc', COUNTRY);
    url.searchParams.set('l', LANG);
    if (!opts.withName) url.searchParams.set('filters', 'price_overview');
    const json = await callJson(url.toString(), {}, 'Steam');
    for (const appid of chunk) {
      const entry = json?.[String(appid)];
      if (!entry?.success) continue;
      const price = entry.data?.price_overview ?? null;
      out.set(appid, {
        name: entry.data?.name ? String(entry.data.name).slice(0, 200) : null,
        price_minor: price && Number.isFinite(Number(price.final)) ? Number(price.final) : null,
        initial_minor:
          price && Number.isFinite(Number(price.initial)) ? Number(price.initial) : null,
        discount:
          price && Number.isFinite(Number(price.discount_percent))
            ? Number(price.discount_percent)
            : 0,
        currency: price?.currency ? String(price.currency) : null,
      });
    }
  }
  return out;
}

/**
 * Публічний wishlist Steam (S-5-2). Профіль закритий - список порожній, і
 * викликач каже про це прямо.
 * @param {string} steamId
 * @returns {Promise<number[]>}
 */
export async function steamWishlist(steamId) {
  const id = String(steamId ?? '').trim();
  if (!/^\d{17}$/.test(id)) throw new Error('steam: steam_id має бути 17 цифр (SteamID64)');
  const url = new URL(STEAM_WISHLIST);
  url.searchParams.set('steamid', id);
  const json = await callJson(url.toString(), {}, 'Steam');
  const items = Array.isArray(json?.response?.items) ? json.response.items : [];
  return items
    .map((/** @type {any} */ it) => Number(it?.appid))
    .filter((/** @type {number} */ n) => Number.isFinite(n) && n > 0);
}

// ── IsThereAnyDeal ─────────────────────────────────────────────────────────

/**
 * appid Steam → id гри в ITAD (потрібен для батча цін). null - гри немає.
 * @param {Env} env @param {number} appid
 * @returns {Promise<{ id: string, title: string } | null>}
 */
export async function itadLookup(env, appid) {
  const url = new URL(ITAD_LOOKUP);
  url.searchParams.set('key', itadApiKey(env));
  url.searchParams.set('appid', String(Number(appid)));
  const json = await callJson(url.toString(), {}, 'ITAD');
  const game = json?.game ?? (json?.id ? json : null);
  if (json?.found === false || !game?.id) return null;
  return { id: String(game.id), title: String(game.title ?? '').slice(0, 200) };
}

/**
 * Батч цін ITAD: найкраща поточна пропозиція + історичний мінімум.
 * @param {Env} env @param {string[]} ids
 * @returns {Promise<Map<string, { best: { shop: string, price_minor: number, currency: string, cut: number, url: string } | null, low_all: number | null, low_year: number | null, low_currency: string | null }>>}
 */
export async function itadPrices(env, ids) {
  /** @type {Map<string, any>} */
  const out = new Map();
  const list = [...new Set(ids.map(String).filter(Boolean))];
  for (let i = 0; i < list.length; i += ITAD_BATCH_MAX) {
    const chunk = list.slice(i, i + ITAD_BATCH_MAX);
    const url = new URL(ITAD_PRICES);
    url.searchParams.set('key', itadApiKey(env));
    url.searchParams.set('country', COUNTRY);
    const json = await callJson(
      url.toString(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk),
      },
      'ITAD',
    );
    for (const row of Array.isArray(json) ? json : []) {
      const id = String(row?.id ?? '');
      if (!id) continue;
      out.set(id, { best: bestDeal(row?.deals), ...historyLow(row?.historyLow) });
    }
  }
  return out;
}

/** Найдешевша пропозиція з валідною ціною. @param {any} deals */
export function bestDeal(deals) {
  /** @type {{ shop: string, price_minor: number, currency: string, cut: number, url: string } | null} */
  let best = null;
  for (const d of Array.isArray(deals) ? deals : []) {
    const minor = Number(d?.price?.amountInt);
    const currency = String(d?.price?.currency ?? '');
    // Валюта з чужого API йде у formatMoney: дозволяємо лише три літери,
    // інакше «toString» витягнув би функцію з прототипу мапи валют.
    if (!Number.isFinite(minor) || minor <= 0 || !CURRENCY_RE.test(currency)) continue;
    if (best && minor >= best.price_minor) continue;
    best = {
      shop: String(d?.shop?.name ?? '—').slice(0, 60),
      price_minor: Math.round(minor),
      currency,
      cut: Number.isFinite(Number(d?.cut)) ? Number(d.cut) : 0,
      url: safeUrl(d?.url),
    };
  }
  return best;
}

/** URL пропозиції: лише https і ≤ 500 символів; решта - порожньо. @param {unknown} raw */
export function safeUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim().slice(0, URL_MAX) : '';
  if (!s) return '';
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}

/** Історичний мінімум («all» - за весь час). @param {any} low */
export function historyLow(low) {
  // ITAD дає три вікна: `all`, `y1` (рік) і `m3`. S-5-3 говорить про «мінімум
  // за рік», але «за весь час» - сильніше твердження, тож віддаємо обидва, а
  // формулювання вибирає викликач.
  const pick = (/** @type {any} */ v) => {
    const minor = Number(v?.amountInt);
    const currency = String(v?.currency ?? '');
    return Number.isFinite(minor) && minor > 0 && CURRENCY_RE.test(currency)
      ? { minor: Math.round(minor), currency }
      : null;
  };
  const all = pick(low?.all ?? (low?.amountInt ? low : null));
  const year = pick(low?.y1);
  return {
    low_all: all?.minor ?? null,
    low_year: year?.minor ?? null,
    low_currency: all?.currency ?? year?.currency ?? null,
  };
}
