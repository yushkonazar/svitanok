// Знижки на ігри (07 §7 `steam-check`, S-5-1…S-5-4, S-5-12, етап 5 PR-5).
//
// Раз на добу о 10:00 Києва: батч цін ITAD по всіх активних бажаннях
// type=game → одне повідомлення про те, що подешевшало («Знижки: Hades II
// −20 % (519 грн, мінімум за весь час)»). Мовчання - штатний результат:
// без знижок і без нового мінімуму нічого не пишемо.
//
// ITAD недоступний (S-5-12): день пропускаємо з логом, три поспіль - алерт у
// «Систему». Лічильник - у KV поруч із міткою дня, бо це стан задачі, а не
// доменні дані.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { formatMoney, savePricePoint } from '../chains/price.mjs';
import { runFactsGet } from '../tools/facts.mjs';
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
export const STEAM_MARKER_KEY = 'steamCheckDay';
export const STEAM_MISS_KEY = 'steamCheckMisses';
/** Частка знижок у списку, за якою це вже схоже на розпродаж (S-5-4). */
export const STEAM_SALE_KEY = 'steamSaleShare';
export const SALE_SHARE = 0.6;
export const SALE_QUIET_SHARE = 0.3;
/** Скільки днів поспіль без цін терпимо мовчки (S-5-12). */
export const MISS_ALERT = 3;
/** Скільки ігор називаємо в одному повідомленні. */
export const MAX_LINES = 12;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/**
 * @typedef {{ id: string, title: string, appid: number | null, itad_id: string | null,
 *   target_price: number | null, currency: string }} GameWish
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
    } catch {
      payload = {};
    }
    return {
      id: String(r.id),
      title: String(r.title ?? ''),
      appid: Number.isFinite(Number(payload.steam_appid)) ? Number(payload.steam_appid) : null,
      itad_id: payload.itad_id ? String(payload.itad_id) : null,
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
 * @param {Env} env @param {{ id: string, title: string, appid?: number | null }} wish
 */
export async function resolveGameWish(env, wish) {
  const found = wish.appid
    ? { appid: wish.appid, name: wish.title, price_minor: null, currency: null }
    : ((await steamSearch(wish.title, 1))[0] ?? null);
  if (!found?.appid) return null;
  const itad = await itadLookup(env, found.appid).catch((/** @type {any} */ e) => {
    console.error(`steam-check: ITAD lookup ${found.appid} впав`, e?.message);
    return null;
  });
  const prices = await steamAppDetails([found.appid]).catch(() => new Map());
  const price = prices.get(found.appid) ?? null;
  await patchWishPayload(env, wish.id, {
    steam_appid: found.appid,
    ...(itad ? { itad_id: itad.id } : {}),
    ...(price?.currency ? { currency: price.currency } : {}),
  });
  const now =
    price?.price_minor != null && price.currency
      ? `, зараз ${formatMoney(price.price_minor, price.currency)}`
      : '';
  return {
    appid: found.appid,
    itad_id: itad?.id ?? null,
    text: `Додав «${found.name || wish.title}» (Steam${now}). Скажу про будь-яку знижку.`,
  };
}

/**
 * S-5-2: імпорт публічного wishlist Steam у бажання. Уже наявні appid
 * пропускаються, тож повтор імпорту нічого не дублює.
 * @param {Env} env @param {{ steam_id?: unknown, limit?: unknown }} args @param {number} nowMs
 */
export async function importSteamWishlist(env, args, nowMs) {
  const steamId = args.steam_id == null ? await settingSteamId(env) : String(args.steam_id).trim();
  if (!steamId) {
    throw new Error(
      'не знаю steam_id: скажи «мій steam id - 7656…» (17 цифр), і я запишу його у факти',
    );
  }
  const limit = Number.isFinite(Number(args.limit)) ? Math.min(200, Number(args.limit)) : 100;
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
  for (const appid of fresh) {
    const d = details.get(appid);
    const title = d?.name ?? `Steam ${appid}`;
    const id = crypto.randomUUID();
    await db(env)
      .prepare(
        `INSERT INTO wishes (id, type, title, payload_json, status, created_at) VALUES (?, 'game', ?, ?, 'active', ?)`,
      )
      .bind(
        id,
        title,
        JSON.stringify({
          steam_appid: appid,
          currency: d?.currency ?? 'UAH',
          source: 'steam-wishlist',
        }),
        iso,
      )
      .run();
    added.push(id);
    titles.push(title);
  }
  const skipped = appids.length - fresh.length;
  return {
    result: {
      added: added.length,
      skipped,
      titles: titles.slice(0, 20),
      text:
        `Імпортував ${added.length} ${added.length === 1 ? 'гру' : 'ігор'} з wishlist Steam` +
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
 * Рядок про одну гру: знижка, ціна, магазин і мінімум.
 * @param {GameWish} wish
 * @param {{ shop: string, price_minor: number, currency: string, cut: number, url: string }} best
 * @param {{ low_minor: number | null, isLow: boolean }} stats
 */
export function discountLine(wish, best, stats) {
  const price = formatMoney(best.price_minor, best.currency);
  const cut = best.cut > 0 ? ` −${best.cut} %` : '';
  const low = stats.isLow
    ? ', мінімум за весь час'
    : stats.low_minor != null && best.price_minor <= stats.low_minor
      ? ', історичний мінімум'
      : '';
  const target =
    wish.target_price != null && best.price_minor <= wish.target_price ? ' 🎯 ціль' : '';
  return `• «${wish.title}»${cut} (${price}, ${best.shop}${low})${target}`;
}

/**
 * Задача `steam-check`: раз на добу о 10:00 Києва.
 * @param {Env} env @param {number} [nowMs]
 */
export async function steamCheckTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== STEAM_CHECK_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(STEAM_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) return { skipped: 'no-db' };
  if (!env.TELEGRAM_CHAT_ID) return { skipped: 'no-chat' };
  if (!env.ITAD_API_KEY) return { skipped: 'no-key' };

  const wishes = await listGameWishes(env);
  if (!wishes.length) {
    await env.BRIEFING.put(STEAM_MARKER_KEY, today);
    return { skipped: 'no-wishes' };
  }
  // Бажанням без itad_id спершу шукаємо id (одна гра - один виклик, лише раз).
  for (const wish of wishes.filter((w) => !w.itad_id && w.appid)) {
    try {
      const found = await itadLookup(env, /** @type {number} */ (wish.appid));
      if (found) {
        wish.itad_id = found.id;
        await patchWishPayload(env, wish.id, { itad_id: found.id });
      }
    } catch (/** @type {any} */ e) {
      console.error(`steam-check: lookup ${wish.appid} впав`, e?.message);
    }
  }
  const tracked = wishes.filter((w) => w.itad_id);
  if (!tracked.length) {
    await env.BRIEFING.put(STEAM_MARKER_KEY, today);
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
    const misses = Number((await env.BRIEFING.get(STEAM_MISS_KEY)) ?? 0) + 1;
    await env.BRIEFING.put(STEAM_MISS_KEY, String(misses));
    await env.BRIEFING.put(STEAM_MARKER_KEY, today);
    if (misses === MISS_ALERT) {
      await alert(
        env,
        `Знижки Steam не перевіряються ${MISS_ALERT} дні поспіль: ${String(e?.message ?? e).slice(0, 160)}`,
        nowMs,
      );
    }
    return { skipped: 'itad-failed', misses };
  }
  // Порожня відповідь - той самий «недоступний» для власника, що й помилка
  // (S-5-12): день пропущено, лічильник іде далі.
  if (prices.size === 0) {
    const misses = Number((await env.BRIEFING.get(STEAM_MISS_KEY)) ?? 0) + 1;
    await env.BRIEFING.put(STEAM_MISS_KEY, String(misses));
    await env.BRIEFING.put(STEAM_MARKER_KEY, today);
    if (misses === MISS_ALERT) {
      await alert(
        env,
        `Знижки Steam не перевіряються ${MISS_ALERT} дні поспіль: ITAD віддає порожню відповідь`,
        nowMs,
      );
    }
    return { skipped: 'itad-empty', misses };
  }
  await env.BRIEFING.put(STEAM_MISS_KEY, '0');

  /** @type {string[]} */
  const lines = [];
  let discounted = 0;
  for (const wish of tracked) {
    const row = prices.get(/** @type {string} */ (wish.itad_id));
    const best = row?.best ?? null;
    if (!best) continue;
    if (best.cut > 0) discounted += 1;
    const stats = await savePricePoint(
      env,
      wish.id,
      {
        price: best.price_minor,
        currency: best.currency,
        source: best.shop,
        url: best.url,
        in_stock: true,
      },
      nowMs,
    );
    const atLow = row.low_minor != null && best.price_minor <= row.low_minor;
    // S-5-3: кажемо лише про знижку або мінімум - і лише коли ціна змінилась.
    const changed = stats.prev == null || best.price_minor < stats.prev;
    if ((best.cut > 0 || atLow) && changed) {
      lines.push(discountLine(wish, best, { low_minor: row.low_minor, isLow: stats.isLow }));
    }
  }

  const share = discounted / tracked.length;
  const saleLine = await salePrefix(env, share, tracked.length, discounted);
  const text = lines.length
    ? [saleLine, 'Знижки:', ...lines.slice(0, MAX_LINES)].filter(Boolean).join('\n')
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
  await env.BRIEFING.put(STEAM_MARKER_KEY, today);
  return {
    sent: lines.length > 0 || Boolean(saleLine),
    games: tracked.length,
    lines: lines.length,
  };
}

/**
 * S-5-4: назви й дат розпродажу безкоштовне API не дає, тому кажемо лише те,
 * що бачимо самі - частку знижок серед відстежуваних ігор, і лише в день,
 * коли вона різко зросла.
 * @param {Env} env @param {number} share @param {number} total @param {number} discounted
 */
export async function salePrefix(env, share, total, discounted) {
  const prev = Number((await env.BRIEFING.get(STEAM_SALE_KEY)) ?? 0);
  await env.BRIEFING.put(STEAM_SALE_KEY, String(Math.round(share * 100) / 100));
  if (total < 5 || share < SALE_SHARE || prev >= SALE_QUIET_SHARE) return '';
  return `Схоже, у Steam великий розпродаж: знижки на ${discounted} з ${total} ігор зі списку.`;
}

/** @param {Env} env @param {string} text @param {number} nowMs */
async function alert(env, text, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) return;
  await enqueueOutbox(
    env,
    {
      chatId: env.TELEGRAM_CHAT_ID,
      threadId: env.TOPIC_SYSTEM ?? null,
      kind: 'send',
      payload: { text },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch(() => {});
}
