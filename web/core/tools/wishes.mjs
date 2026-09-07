// Бажання (07 §1 `wishes`, §4 `wishes.*`, S-5-1/S-5-11, етап 5 PR-3):
// type game·trip·purchase; payload_json - {url, target_price, currency,
// steam_appid, itad_id, trip_id}. Гроші - INTEGER у мінімальних одиницях
// (копійки) + currency (07 §1); модель дає ціну в основних одиницях (3 299),
// ядро множить. create/update - T0 через policy з «↩», delete - T1,
// list/search - читання. purchase з url - одразу ланцюг PriceTrack (S-5-11);
// status done/cancelled або delete - зупинка ланцюга. Ігри (Steam/ITAD) -
// PR-5 (steam-check + import).

import { startPriceTrack, cancelPriceTrack, parseAmount, trackingText } from '../chains/price.mjs';
import { formatMoney } from '../format.mjs';
import { resolveGameWish } from '../steam/check.mjs';

export const WISH_TYPES = ['game', 'trip', 'purchase'];
export const WISH_STATUSES = ['active', 'done', 'cancelled'];
export const WISHES_LIST_MAX = 20;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** @typedef {{ id: string, type: string, title: string, payload: Record<string, any>, status: string, created_at: string }} WishRow */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - wishes недоступні');
  return env.DB;
}

/** @param {any} row @returns {WishRow} */
function toWish(row) {
  /** @type {Record<string, any>} */
  let payload;
  try {
    payload = row.payload_json ? JSON.parse(String(row.payload_json)) : {};
  } catch {
    payload = {};
  }
  return {
    id: String(row.id),
    type: String(row.type),
    title: String(row.title ?? ''),
    payload,
    status: String(row.status ?? 'active'),
    created_at: String(row.created_at ?? ''),
  };
}

/** Ціна від моделі (основні одиниці: 3299, «3 299,50», «3.299») → копійки. @param {unknown} v */
export function toMinor(v) {
  if (v == null || v === '') return null;
  // Той самий розбір, що в звіті Дослідника: крапка може бути тисячником.
  const n =
    typeof v === 'number'
      ? v
      : /^[\d\s.,]+$/.test(String(v))
        ? (parseAmount(String(v)) ?? NaN)
        : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`ціна «${String(v)}» не число`);
  return Math.round(n * 100);
}

/** @param {unknown} v */
function currencyOf(v) {
  const c = String(v ?? 'UAH')
    .trim()
    .toUpperCase();
  if (!CURRENCY_RE.test(c))
    throw new Error(`currency «${String(v)}» - потрібен код ISO (UAH, USD)`);
  return c;
}

/** @param {unknown} v */
function urlOf(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`url «${s}» некоректний`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('url має бути http(s)');
  return u.toString().slice(0, 500);
}

/**
 * Бажання за посиланням власника: id або точна/унікальна назва.
 * @param {Env} env @param {unknown} ref
 * @returns {Promise<WishRow | null>}
 */
export async function findWish(env, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  const { results } = await db(env)
    .prepare(
      `SELECT * FROM wishes WHERE id = ? OR title LIKE ?
       ORDER BY (id = ?) DESC, (lower(title) = lower(?)) DESC, created_at DESC LIMIT 3`,
    )
    .bind(key, `%${key.replace(/[%_]/g, '')}%`, key, key)
    .all();
  const rows = (results ?? []).map(toWish);
  if (rows.length === 0) return null;
  const exact = rows.find((w) => w.id === key || w.title.toLowerCase() === key.toLowerCase());
  if (exact) return exact;
  if (rows.length === 1) return rows[0] ?? null;
  // Кілька збігів - помилка з переліком, а не «немає»: інакше модель створить
  // дубль замість уточнення (ревʼю етапу 5).
  throw new Error(
    `«${key}» підходить до кількох бажань: ${rows.map((w) => `«${w.title}» (${w.id})`).join(', ')} - уточни id`,
  );
}

/**
 * wishes.create: {type, title, url?, target_price?, currency?, steam_appid?}.
 * purchase з url → PriceTrack одразу (S-5-11); без привʼязки - результат
 * каже про це прямо (не тихо).
 * @param {Env} env
 * @param {Record<string, unknown>} args
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} [ctx]
 */
export async function runWishesCreate(env, args, nowMs, ctx = {}) {
  const type = String(args.type ?? '');
  if (!WISH_TYPES.includes(type)) {
    throw new Error(`невідомий type «${type}» (чинні: ${WISH_TYPES.join(', ')})`);
  }
  const title = String(args.title ?? '')
    .trim()
    .slice(0, 200);
  if (!title) throw new Error('title не може бути порожнім');
  const url = urlOf(args.url);
  const target = toMinor(args.target_price);
  const currency = currencyOf(args.currency);
  /** @type {Record<string, unknown>} */
  const payload = {
    ...(url ? { url } : {}),
    ...(target != null ? { target_price: target } : {}),
    currency,
    ...(args.steam_appid != null ? { steam_appid: Number(args.steam_appid) } : {}),
  };
  const id = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO wishes (id, type, title, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(id, type, title, JSON.stringify(payload), iso)
    .run();
  /** @type {{ id: string, type: string, title: string, target_price?: string, tracking?: boolean, chain_id?: string, text?: string, note?: string }} */
  const result = {
    id,
    type,
    title,
    ...(target != null ? { target_price: formatMoney(target, currency) } : {}),
  };
  if (type === 'purchase' && url) {
    if (env.PRICE_TRACK) {
      const chain = await startPriceTrack(
        env,
        { id, title, url, target_price: target, currency },
        nowMs,
        ctx,
      );
      result.tracking = true;
      result.chain_id = chain.chainId;
      result.text = trackingText(title, target, currency);
    } else {
      result.tracking = false;
      result.note = 'привʼязки PRICE_TRACK немає - відстеження ціни недоступне, бажання записано';
    }
  } else if (type === 'purchase') {
    result.note = 'без url ціну не відстежую - попроси посилання на товар';
  } else if (type === 'game') {
    // S-5-1: знаходимо гру в Steam і в ITAD одразу - далі щоденна перевірка
    // знижок бере її батчем без жодного пошуку.
    try {
      const game = await resolveGameWish(env, {
        id,
        title,
        appid: args.steam_appid == null ? null : Number(args.steam_appid),
      });
      if (game) {
        result.text = game.text;
        result.tracking = true;
      } else {
        result.note = 'у Steam такої гри не знайшов - скажи точну назву або appid';
      }
    } catch (/** @type {any} */ e) {
      console.error(`wishes.create: гра «${title}» не знайдена`, e?.message);
      result.note = `Steam/ITAD недоступні (${String(e?.message ?? e).slice(0, 80)}) - бажання записав, знижки перевірю завтра`;
    }
  }
  return { result, prev: { id } };
}

/**
 * wishes.update: {id, title?, url?, target_price?, currency?, status?}.
 * Знімок ДО правки - для «↩». status done/cancelled зупиняє PriceTrack.
 * @param {Env} env
 * @param {Record<string, unknown> & { id: unknown }} args
 * @param {number} nowMs
 */
export async function runWishesUpdate(env, args, nowMs) {
  const wish = await findWish(env, args.id);
  if (!wish) throw new Error(`бажання «${String(args.id)}» немає`);
  const title = args.title == null ? wish.title : String(args.title).trim().slice(0, 200);
  if (!title) throw new Error('title не може бути порожнім');
  const status = args.status == null ? wish.status : String(args.status);
  if (!WISH_STATUSES.includes(status)) {
    throw new Error(`невідомий status «${status}» (чинні: ${WISH_STATUSES.join(', ')})`);
  }
  const payload = { ...wish.payload };
  if (args.url !== undefined) {
    const url = urlOf(args.url);
    if (url) payload.url = url;
    else delete payload.url;
  }
  if (args.target_price !== undefined) {
    const target = toMinor(args.target_price);
    if (target != null) payload.target_price = target;
    else delete payload.target_price;
  }
  if (args.currency !== undefined) payload.currency = currencyOf(args.currency);
  await db(env)
    .prepare('UPDATE wishes SET title = ?, payload_json = ?, status = ? WHERE id = ?')
    .bind(title, JSON.stringify(payload), status, wish.id)
    .run();
  /** @type {Record<string, unknown>} */
  const result = { id: wish.id, title, status };
  if (status !== 'active' && wish.status === 'active') {
    const stopped = await cancelPriceTrack(env, wish.id, nowMs);
    if (stopped) result.tracking_stopped = true;
  }
  return {
    result,
    prev: {
      id: wish.id,
      title: wish.title,
      payload_json: JSON.stringify(wish.payload),
      status: wish.status,
    },
  };
}

/** Відкат update: поля назад (ланцюг, зупинений при done, не воскрешаємо - про це кажемо). @param {Env} env @param {{ id: string, title: string, payload_json: string, status: string }} snap */
export async function restoreWish(env, snap) {
  await db(env)
    .prepare('UPDATE wishes SET title = ?, payload_json = ?, status = ? WHERE id = ?')
    .bind(snap.title, snap.payload_json, snap.status, snap.id)
    .run();
}

/**
 * wishes.list: {type?, status?, limit?} - з останньою і найнижчою ціною.
 * @param {Env} env @param {{ type?: string, status?: string, limit?: number }} args
 */
export async function runWishesList(env, args) {
  const where = [];
  const binds = [];
  if (args.type != null) {
    if (!WISH_TYPES.includes(String(args.type))) throw new Error(`невідомий type «${args.type}»`);
    where.push('w.type = ?');
    binds.push(String(args.type));
  }
  const status = args.status == null ? 'active' : String(args.status);
  if (status !== 'all') {
    if (!WISH_STATUSES.includes(status)) throw new Error(`невідомий status «${status}»`);
    where.push('w.status = ?');
    binds.push(status);
  }
  const limit = Math.min(WISHES_LIST_MAX, Math.max(1, Math.floor(Number(args.limit) || 10)));
  const { results } = await db(env)
    .prepare(
      `SELECT w.*, (SELECT price FROM price_points p WHERE p.wish_id = w.id ORDER BY at DESC LIMIT 1) AS last_price,
              (SELECT currency FROM price_points p WHERE p.wish_id = w.id ORDER BY at DESC LIMIT 1) AS last_currency,
              (SELECT at FROM price_points p WHERE p.wish_id = w.id ORDER BY at DESC LIMIT 1) AS last_at,
              (SELECT MIN(price) FROM price_points p WHERE p.wish_id = w.id) AS min_price
       FROM wishes w ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY w.created_at DESC LIMIT ?`,
    )
    .bind(...binds, limit)
    .all();
  return {
    result: (results ?? []).map((r) => {
      const w = toWish(r);
      const cur = String(r.last_currency ?? w.payload.currency ?? 'UAH');
      return {
        id: w.id,
        type: w.type,
        title: w.title,
        status: w.status,
        url: w.payload.url ?? null,
        target_price:
          w.payload.target_price != null ? formatMoney(w.payload.target_price, cur) : null,
        last_price: r.last_price != null ? formatMoney(Number(r.last_price), cur) : null,
        last_at: r.last_at == null ? null : String(r.last_at).slice(0, 10),
        min_price: r.min_price != null ? formatMoney(Number(r.min_price), cur) : null,
      };
    }),
  };
}

/** wishes.search: за назвою (LIKE), усі статуси. @param {Env} env @param {{ q: string }} args */
export async function runWishesSearch(env, args) {
  const q = String(args.q ?? '')
    .trim()
    .replace(/[%_]/g, '');
  const { results } = await db(env)
    .prepare(`SELECT * FROM wishes WHERE title LIKE ? ORDER BY created_at DESC LIMIT ?`)
    .bind(`%${q}%`, WISHES_LIST_MAX)
    .all();
  return {
    result: (results ?? []).map((r) => {
      const w = toWish(r);
      return {
        id: w.id,
        type: w.type,
        title: w.title,
        status: w.status,
        url: w.payload.url ?? null,
      };
    }),
  };
}

/**
 * wishes.delete (T1): рядок + історія цін; ланцюг PriceTrack зупиняється.
 * @param {Env} env @param {{ id: unknown }} args @param {number} nowMs
 */
export async function runWishesDelete(env, args, nowMs) {
  const wish = await findWish(env, args.id);
  if (!wish) throw new Error(`бажання «${String(args.id)}» немає`);
  await cancelPriceTrack(env, wish.id, nowMs);
  await db(env).prepare('DELETE FROM price_points WHERE wish_id = ?').bind(wish.id).run();
  await db(env).prepare('DELETE FROM wishes WHERE id = ?').bind(wish.id).run();
  return { result: { id: wish.id, title: wish.title, deleted: true } };
}

/** Видалити щойно створене (відкат create): ланцюг теж. @param {Env} env @param {string} id @param {number} nowMs */
export async function deleteWishRow(env, id, nowMs) {
  await cancelPriceTrack(env, id, nowMs);
  await db(env).prepare('DELETE FROM price_points WHERE wish_id = ?').bind(id).run();
  await db(env).prepare('DELETE FROM wishes WHERE id = ?').bind(id).run();
}
