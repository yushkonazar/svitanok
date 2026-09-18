// Знижки на ігри (07 §7 `steam-check`, S-5-1…S-5-4, S-5-12, етап 5 PR-5).
//
// Раз на добу о 10:00 Києва: батч цін ITAD по всіх активних бажаннях
// type=game → одне повідомлення про те, що подешевшало («Знижки: • «Hades
// II» −20 % (519 грн, Steam, мінімум за рік)»). Мовчання - штатний
// результат: без знижок і без нового мінімуму нічого не пишемо.
//
// Правила, які тут коштували найдорожче:
// - точка ціни на добу ОДНА (за київським днем), а «подешевшало» рахується
//   проти ціни ПОПЕРЕДНЬОГО дня: інакше повторний прогін після збою бачив би
//   власний сьогоднішній запис і мовчав би назавжди;
// - «мінімум» - це мінімум ITAD, а не наша коротка історія;
// - жодного тихого пропуску: немає ключа, бази чи чату - у лог, а лічильник
//   пропусків веде до алерту (S-5-12).

import { kyivHour, kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { isQuietMinute } from '../../settings-core.mjs';
import { enqueueOutbox, drainOutbox, sendSystemAlert } from '../tg/outbox.mjs';
import { formatMoney, cleanSource } from '../format.mjs';
import { runFactsGet } from '../tools/facts.mjs';
import {
  readSteamCheckLegacy,
  steamCheckClaim,
  steamCheckComplete,
  steamCheckRelease,
} from '../steam-check-state/client.mjs';
import {
  STEAM_CHECK_LEASE_MS,
  STEAM_MARKER_KEY,
  STEAM_MISS_KEY,
  STEAM_SALE_KEY,
} from '../steam-check-state/contract.mjs';
import {
  itadLookup,
  itadPrices,
  steamAppDetails,
  steamSearch,
  steamWishlist,
} from '../adapters/steam.mjs';

/** Година перевірки за Києвом (07 §7). */
export const STEAM_CHECK_HOUR = 10;
/** Мітка «сьогодні вже перевіряли» і лічильник збоїв поспіль. */
export { STEAM_MARKER_KEY, STEAM_MISS_KEY, STEAM_SALE_KEY };
/** Частка знижок у списку, за якою це вже схоже на розпродаж (S-5-4). */
export const SALE_SHARE = 0.6;
export const SALE_QUIET_SHARE = 0.3;
/** Скільки днів поспіль без цін терпимо мовчки (S-5-12). */
export const MISS_ALERT = 3;
/** Скільки ігор називаємо в одному повідомленні. */
export const MAX_LINES = 12;
/** Скільки ігор беремо в один прогін (решта - наступного дня). */
export const TRACKED_MAX = 200;
/** Скільки appid шукаємо в ITAD за прогін: решта дочекається завтра. */
export const LOOKUPS_PER_RUN = 20;
/** Як часто повторювати пошук гри, якої ITAD не знає (діб). */
export const LOOKUP_RETRY_DAYS = 7;
/** Хвилина години, після якої збій уже вважається пропуском дня. */
export const LAST_MINUTE = 55;
/** Стеля назви гри зі стороннього API в наших рядках. */
const TITLE_MAX = 120;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * @typedef {{ id: string, title: string, appid: number | null, itad_id: string | null,
 *   itad_missing_at: string | null, target_price: number | null, currency: string }} GameWish
 */

/**
 * Бажання-ігри. Типово - лише активні; `all` потрібен дедупу імпорту:
 * закриту гру повторний імпорт додав би вдруге.
 * @param {Env} env @param {{ all?: boolean }} [opts] @returns {Promise<GameWish[]>}
 */
export async function listGameWishes(env, opts = {}) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, title, payload_json FROM wishes WHERE type = 'game'
         AND (? = 1 OR status = 'active') ORDER BY created_at`,
    )
    .bind(opts.all ? 1 : 0)
    .all();
  return (results ?? []).map((r) => {
    /** @type {any} */
    let payload;
    try {
      payload = JSON.parse(String(r.payload_json ?? '{}'));
    } catch (/** @type {any} */ e) {
      console.error(`steam-check: payload бажання ${String(r.id)} не читається`, e?.message);
      payload = {};
    }
    return {
      id: String(r.id),
      title: String(r.title ?? ''),
      appid: Number.isFinite(Number(payload.steam_appid)) ? Number(payload.steam_appid) : null,
      itad_id: payload.itad_id ? String(payload.itad_id) : null,
      itad_missing_at: payload.itad_missing_at ? String(payload.itad_missing_at) : null,
      target_price: Number.isFinite(Number(payload.target_price))
        ? Number(payload.target_price)
        : null,
      currency: String(payload.currency ?? 'UAH'),
    };
  });
}

/**
 * Дописати в payload бажання (json_patch: ключі не затираються).
 * @param {Env} env @param {string} wishId @param {Record<string, unknown>} patch
 */
export async function patchWishPayload(env, wishId, patch) {
  await db(env)
    .prepare(
      `UPDATE wishes SET payload_json = json_patch(COALESCE(payload_json, '{}'), ?) WHERE id = ?`,
    )
    .bind(JSON.stringify(patch), wishId)
    .run();
}

/**
 * S-5-1: знайти гру в Steam і в ITAD за назвою (або за вже відомим appid) і
 * записати в бажання. Повертає рядок для власника; null - не знайшли.
 * Назву з магазину в текст НЕ беремо: у результаті інструмента вона пішла б
 * у контекст моделі як «чистий» текст. Власнику відповідаємо його назвою.
 * @param {Env} env @param {{ id: string, title: string, appid?: number | null }} wish
 */
export async function resolveGameWish(env, wish) {
  const searched = wish.appid ? null : ((await steamSearch(wish.title, 1))[0] ?? null);
  const appid = wish.appid ?? searched?.appid ?? null;
  if (!appid) return null;
  const itad = await itadLookup(env, appid).catch((/** @type {any} */ e) => {
    console.error(`steam-check: ITAD lookup ${appid} впав`, e?.message);
    return null;
  });
  // Ціну вже дав пошук; окремий appdetails потрібен лише коли пошуку не було.
  let price = searched?.price_minor != null ? searched : null;
  if (!price) {
    const details = await steamAppDetails([appid]).catch((/** @type {any} */ e) => {
      console.error(`steam-check: appdetails ${appid} впав`, e?.message);
      return new Map();
    });
    price = details.get(appid) ?? null;
  }
  await patchWishPayload(env, wish.id, {
    steam_appid: appid,
    ...(itad ? { itad_id: itad.id } : {}),
    ...(price?.currency ? { currency: price.currency } : {}),
  });
  const now =
    price?.price_minor != null && price.currency
      ? `, зараз ${formatMoney(price.price_minor, price.currency)}`
      : '';
  // Обіцяємо стежити лише тоді, коли справді можемо: без id в ITAD гра в
  // щоденний батч не потрапляє.
  const tail = itad
    ? 'Скажу про будь-яку знижку.'
    : 'Ціни поки не знайшов - спробую ще раз найближчими днями.';
  return { appid, itad_id: itad?.id ?? null, text: `Додав «${wish.title}» (Steam${now}). ${tail}` };
}

/** «2 гри» / «5 ігор» / «21 гра». @param {number} n */
export function gamesWord(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ігор`;
  if (mod10 === 1) return `${n} гру`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} гри`;
  return `${n} ігор`;
}

/**
 * S-5-2: імпорт публічного wishlist Steam у бажання. Уже наявні appid
 * пропускаються (у будь-якому статусі), тож повтор нічого не дублює.
 * @param {Env} env @param {{ steam_id?: unknown, limit?: unknown }} args @param {number} nowMs
 */
export async function importSteamWishlist(env, args, nowMs) {
  const steamId = args.steam_id == null ? await settingSteamId(env) : String(args.steam_id).trim();
  if (!steamId) {
    throw new Error(
      'не знаю steam_id: скажи «мій steam id - 7656…» (17 цифр), і я запишу його у факти',
    );
  }
  // Кламп ДВОБІЧНИЙ і тут, а не лише в схемі роутера: через proposals.create
  // payload доходить сюди без звірки зі схемою інструмента, і `limit: -50`
  // перетворив би slice на «майже весь список».
  const limit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(200, Math.floor(Number(args.limit))))
    : 100;
  const appids = (await steamWishlist(steamId)).slice(0, limit);
  if (!appids.length) {
    return {
      result: {
        added: 0,
        titles: [],
        text: 'Wishlist порожній або профіль закритий у налаштуваннях приватності Steam.',
      },
      prev: undefined,
    };
  }
  const known = new Set(
    (await listGameWishes(env, { all: true })).map((w) => w.appid).filter((a) => a != null),
  );
  const fresh = appids.filter((a) => !known.has(a));
  const details = await steamAppDetails(fresh, { withName: true });
  const iso = new Date(nowMs).toISOString();
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const titles = [];
  /** @type {any[]} */
  const inserts = [];
  const stmt = db(env).prepare(
    `INSERT INTO wishes (id, type, title, payload_json, status, created_at) VALUES (?, 'game', ?, ?, 'active', ?)`,
  );
  for (const appid of fresh) {
    const d = details.get(appid);
    // Назва приходить із чужого API і йде і в базу, і власнику в чат:
    // знімаємо розмітку й голі URL (як для магазинів у цінах бажань).
    const title = d?.name ? cleanSource(d.name, TITLE_MAX) : `Steam ${appid}`;
    const id = crypto.randomUUID();
    inserts.push(
      stmt.bind(
        id,
        title,
        JSON.stringify({
          steam_appid: appid,
          currency: d?.currency ?? 'UAH',
          source: 'steam-wishlist',
        }),
        iso,
      ),
    );
    added.push(id);
    titles.push(title);
  }
  if (inserts.length) await db(env).batch(inserts);
  const skipped = appids.length - fresh.length;
  return {
    result: {
      added: added.length,
      skipped,
      titles: titles.slice(0, 20),
      text:
        `Імпортував ${gamesWord(added.length)} з wishlist Steam` +
        `${skipped ? ` (${skipped} вже були)` : ''}. Скажу, коли щось подешевшає.`,
    },
    prev: { ids: added },
  };
}

/** SteamID64 із фактів (`facts.setting.steam_id`). @param {Env} env */
export async function settingSteamId(env) {
  const { result } = await runFactsGet(env, { kind: 'setting', key: 'steam_id' });
  const value = /** @type {any} */ (result[0])?.value;
  const id =
    value == null ? '' : String(typeof value === 'object' ? (value.id ?? '') : value).trim();
  return /^\d{17}$/.test(id) ? id : null;
}

/**
 * Ціна попереднього дня, наш мінімум і чи є вже точка за сьогодні - одним
 * запитом. Порівняння - лише в межах однієї валюти.
 * @param {Env} env @param {string} wishId @param {string} currency @param {string} dayStartIso
 * @returns {Promise<{ prev: number | null, min: number | null, today: number }>}
 */
export async function readPriceStats(env, wishId, currency, dayStartIso) {
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT (SELECT price FROM price_points WHERE wish_id = ?1 AND currency = ?2 AND at < ?3 ORDER BY at DESC LIMIT 1) AS prev,
                (SELECT MIN(price) FROM price_points WHERE wish_id = ?1 AND currency = ?2) AS min_price,
                (SELECT COUNT(*) FROM price_points WHERE wish_id = ?1 AND at >= ?3) AS today`,
      )
      .bind(wishId, currency, dayStartIso)
      .first()
  );
  return {
    prev: row?.prev == null ? null : Number(row.prev),
    min: row?.min_price == null ? null : Number(row.min_price),
    today: Number(row?.today ?? 0),
  };
}

/**
 * Точка ціни за сьогодні - одна: повторний прогін після збою не додає другу
 * і не затирає вчорашню ціну як базу порівняння.
 * @param {Env} env @param {string} wishId
 * @param {{ price: number, currency: string, source: string, url: string, isLow: boolean }} p
 * @param {number} nowMs
 */
export async function insertPricePoint(env, wishId, p, nowMs) {
  await db(env)
    .prepare(
      `INSERT INTO price_points (id, wish_id, at, source, price, currency, url, is_low) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      wishId,
      new Date(nowMs).toISOString(),
      p.source,
      p.price,
      p.currency,
      p.url,
      p.isLow ? 1 : 0,
    )
    .run();
}

/**
 * Рядок про одну гру: знижка, ціна, магазин і мінімум. «Мінімум» - лише за
 * даними ITAD; наша власна коротка історія називається чесно.
 * @param {GameWish} wish
 * @param {{ shop: string, price_minor: number, currency: string, cut: number, url: string }} best
 * @param {{ low_year: number | null, low_all: number | null, low_currency: string | null, ourLow: boolean }} stats
 */
export function discountLine(wish, best, stats) {
  const price = formatMoney(best.price_minor, best.currency);
  const cut = best.cut > 0 ? ` −${best.cut} %` : '';
  const sameCurrency = stats.low_currency === best.currency;
  let low = '';
  if (sameCurrency && stats.low_all != null && best.price_minor <= stats.low_all) {
    low = ', мінімум за весь час';
  } else if (sameCurrency && stats.low_year != null && best.price_minor <= stats.low_year) {
    low = ', мінімум за рік';
  } else if (stats.ourLow) {
    low = ', найдешевше, відколи стежу';
  }
  // Ціль порівнюємо ЛИШЕ в тій самій валюті: 519 грн проти цілі «20 USD» -
  // це не «дешевше», а різні шкали (та сама пастка, що в цінах бажань).
  const target =
    wish.target_price != null &&
    best.currency === wish.currency &&
    best.price_minor <= wish.target_price
      ? ' 🎯 ціль'
      : '';
  return `• «${cleanSource(wish.title, TITLE_MAX)}»${cut} (${price}, ${cleanSource(best.shop)}${low})${target}`;
}

/**
 * Пропуск дня: лічильник, алерт на третій раз і мітка (щоб не крутитись).
 * До кінця вікна 10:00 збій НЕ спалює добу - тік через 5 хв спробує ще раз.
 * @param {Env} env @param {{completedDay: string, misses: number, saleShare: number}} state
 * @param {string|null|undefined} token @param {string} today @param {string} reason @param {number} nowMs
 */
async function missDay(env, state, token, today, reason, nowMs) {
  const lastChance = kyivMinuteOfDay(new Date(nowMs)) % 60 >= LAST_MINUTE;
  if (!lastChance) return { result: { skipped: reason, retry: true }, terminal: false };
  const misses = state.misses + 1;
  const committed = await steamCheckComplete(env, token, {
    ...state,
    completedDay: today,
    misses,
  });
  if (!committed) throw new Error('steam-check: добовий стан утратив lease');
  if (misses === MISS_ALERT) {
    await sendSystemAlert(
      env,
      `Знижки Steam не перевіряються ${MISS_ALERT} дні поспіль: ${reason}`,
      nowMs,
    );
  }
  return { result: { skipped: reason, misses }, terminal: true };
}

/**
 * Задача `steam-check`: раз на добу о 10:00 Києва.
 * @param {Env} env @param {number} [nowMs]
 */
export async function steamCheckTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== STEAM_CHECK_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  const claim = await steamCheckClaim(
    env,
    await readSteamCheckLegacy(env),
    today,
    nowMs,
    STEAM_CHECK_LEASE_MS,
  );
  if (!claim.ok) return { skipped: claim.reason };
  const state = /** @type {{completedDay: string, misses: number, saleShare: number}} */ (
    claim.state
  );
  let terminal = false;
  try {
    if (!env.DB) {
      console.error('steam-check: привʼязки DB немає - знижки не перевіряються');
      return { skipped: 'no-db' };
    }
    if (!env.TELEGRAM_CHAT_ID) {
      console.error('steam-check: TELEGRAM_CHAT_ID немає - нікуди слати знижки');
      return { skipped: 'no-chat' };
    }
    if (!env.ITAD_API_KEY) {
      // Тиха деградація заборонена: власнику обіцяли говорити про знижки.
      console.error('steam-check: ITAD_API_KEY не заданий - знижки не перевіряються');
      const missed = await missDay(
        env,
        state,
        claim.token,
        today,
        'ITAD_API_KEY не заданий',
        nowMs,
      );
      terminal = missed.terminal;
      return missed.result;
    }
    // Тиха зона власника - та сама, що для підказок і нагадувань.
    if (isQuietMinute(await loadSettings(env), kyivMinuteOfDay(now))) return { skipped: 'quiet' };

    const wishes = await listGameWishes(env);
    if (!wishes.length) {
      terminal = await steamCheckComplete(env, claim.token, { ...state, completedDay: today });
      if (!terminal) throw new Error('steam-check: добовий стан утратив lease');
      return { skipped: 'no-wishes' };
    }
    // Бажанням без itad_id шукаємо id - але не частіше, ніж раз на тиждень для
    // тих, кого ITAD не знає, і зі стелею на прогін (після імпорту сотні ігор
    // перший ранок не має стати сотнею послідовних зовнішніх викликів).
    const retryBefore = new Date(nowMs - LOOKUP_RETRY_DAYS * 86_400_000).toISOString();
    const pending = wishes
      .filter((w) => !w.itad_id && w.appid)
      .filter((w) => w.itad_missing_at == null || w.itad_missing_at < retryBefore)
      .slice(0, LOOKUPS_PER_RUN);
    for (const wish of pending) {
      try {
        const found = await itadLookup(env, /** @type {number} */ (wish.appid));
        if (found) {
          wish.itad_id = found.id;
          await patchWishPayload(env, wish.id, { itad_id: found.id, itad_missing_at: null });
        } else {
          await patchWishPayload(env, wish.id, { itad_missing_at: new Date(nowMs).toISOString() });
        }
      } catch (/** @type {any} */ e) {
        console.error(`steam-check: lookup ${wish.appid} впав`, e?.message);
      }
    }
    const tracked = wishes.filter((w) => w.itad_id).slice(0, TRACKED_MAX);
    if (!tracked.length) {
      terminal = await steamCheckComplete(env, claim.token, { ...state, completedDay: today });
      if (!terminal) throw new Error('steam-check: добовий стан утратив lease');
      return { skipped: 'no-itad-ids' };
    }

    /** @type {Map<string, any>} */
    let prices;
    try {
      prices = await itadPrices(
        env,
        tracked.map((w) => /** @type {string} */ (w.itad_id)),
      );
    } catch (/** @type {any} */ e) {
      // S-5-12: пропуск дня з логом; три поспіль - алерт.
      console.error('steam-check: ціни ITAD не отримані', e?.message);
      const missed = await missDay(
        env,
        state,
        claim.token,
        today,
        String(e?.message ?? e).slice(0, 160),
        nowMs,
      );
      terminal = missed.terminal;
      return missed.result;
    }

    /** @type {string[]} */
    const lines = [];
    /** @type {{ wishId: string, point: { price: number, currency: string, source: string, url: string, isLow: boolean } }[]} */
    const points = [];
    const dayStartIso = `${today}T00:00:00.000Z`;
    let withPrice = 0;
    let discounted = 0;
    for (const wish of tracked) {
      const row = prices.get(/** @type {string} */ (wish.itad_id));
      const best = row?.best ?? null;
      if (!best) continue;
      withPrice += 1;
      if (best.cut > 0) discounted += 1;
      const stats = await readPriceStats(env, wish.id, best.currency, dayStartIso);
      const ourLow = stats.min == null || best.price_minor <= stats.min;
      const atLow =
        row.low_currency === best.currency &&
        ((row.low_all != null && best.price_minor <= row.low_all) ||
          (row.low_year != null && best.price_minor <= row.low_year));
      // S-5-3: кажемо лише про знижку або мінімум - і лише коли ціна змінилась
      // проти ПОПЕРЕДНЬОГО дня (сьогоднішній запис на це не впливає).
      if ((best.cut > 0 || atLow) && (stats.prev == null || best.price_minor < stats.prev)) {
        lines.push(
          discountLine(wish, best, {
            low_year: row.low_year,
            low_all: row.low_all,
            low_currency: row.low_currency,
            ourLow,
          }),
        );
      }
      // Точка на добу одна: повторний прогін після збою не псує базу порівняння.
      if (stats.today === 0) {
        points.push({
          wishId: wish.id,
          point: {
            price: best.price_minor,
            currency: best.currency,
            source: cleanSource(best.shop),
            url: best.url,
            isLow: ourLow,
          },
        });
      }
    }
    const missing = tracked.length - withPrice;
    if (missing) console.error(`steam-check: без цін лишились ${missing} з ${tracked.length} ігор`);
    // Більшість списку без цін - це той самий «недоступний», що й помилка.
    if (withPrice === 0 || missing > tracked.length / 2) {
      const missed = await missDay(
        env,
        state,
        claim.token,
        today,
        `ITAD віддав ціни лише для ${withPrice} з ${tracked.length}`,
        nowMs,
      );
      terminal = missed.terminal;
      return missed.result;
    }

    const share = discounted / withPrice;
    const saleLine = salePrefixFromPrevious(state.saleShare, share, withPrice, discounted);
    const shown = lines.slice(0, MAX_LINES);
    const rest = lines.length - shown.length;
    const text = lines.length
      ? [saleLine, 'Знижки:', ...shown, rest > 0 ? `…і ще ${gamesWord(rest)} зі знижкою.` : '']
          .filter(Boolean)
          .join('\n')
      : saleLine;
    if (text) {
      await enqueueOutbox(
        env,
        {
          chatId: env.TELEGRAM_CHAT_ID,
          threadId: env.TOPIC_ASSISTANT ?? null,
          kind: 'send',
          payload: { text },
        },
        nowMs,
      );
      await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
        console.error('steam-check: драйн outbox впав, добере sweeper', e?.message),
      );
    }
    // Точки пишемо ПІСЛЯ відправки: якщо збій станеться раніше, наступний тік
    // повторить прогін із тією самою базою порівняння і скаже про знижку.
    for (const p of points) await insertPricePoint(env, p.wishId, p.point, nowMs);
    terminal = await steamCheckComplete(env, claim.token, {
      ...state,
      completedDay: today,
      misses: 0,
      saleShare: Math.round(share * 100) / 100,
    });
    if (!terminal) throw new Error('steam-check: добовий стан утратив lease');
    return {
      sent: lines.length > 0 || Boolean(saleLine),
      games: tracked.length,
      priced: withPrice,
      lines: lines.length,
    };
  } finally {
    if (!terminal) await steamCheckRelease(env, claim.token);
  }
}

/**
 * S-5-4: назви й дат розпродажу безкоштовне API не дає, тому кажемо лише те,
 * що бачимо самі - частку знижок серед ігор, по яких прийшли ціни, і лише в
 * день, коли вона різко зросла.
 * @param {Env} env @param {number} share @param {number} total @param {number} discounted
 */
export async function salePrefix(env, share, total, discounted) {
  const prev = Number((await env.BRIEFING.get(STEAM_SALE_KEY)) ?? 0);
  await env.BRIEFING.put(STEAM_SALE_KEY, String(Math.round(share * 100) / 100));
  return salePrefixFromPrevious(prev, share, total, discounted);
}

/** @param {number} prev @param {number} share @param {number} total @param {number} discounted */
export function salePrefixFromPrevious(prev, share, total, discounted) {
  if (total < 5 || share < SALE_SHARE || prev >= SALE_QUIET_SHARE) return '';
  return `Схоже, у Steam великий розпродаж: знижки на ${discounted} з ${total} ігор зі списку.`;
}
