// Читання фінансів: розбір періоду і зрізи транзакцій (07 §4 `finance.query`,
// docs/assistant/agents/finance.md).
//
// Усі межі - КИЇВСЬКІ (доба власника, тиждень з понеділка), а суми - у
// гривневому еквіваленті `amount_uah`: складати долари з гривнями не можна, а
// курс уже лежить у самій транзакції. Операції без `amount_uah` (валютний
// рахунок) у суми не входять і повертаються окремим числом `unconverted` -
// чесний пропуск замість тихого нуля.
//
// Порівняння з попереднім періодом - рівно та сама тривалість одразу перед
// `from`: «база» Фінансиста в кожній відповіді.

import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { merchantKey } from './rules.mjs';
import { NOT_TEST_SQL } from './store.mjs';

/** Скільки транзакцій віддаємо списком (решта - у сумах). */
export const LIST_MAX = 40;
/** Скільки розрізів за категоріями/мерчантами. */
export const BREAKDOWN_MAX = 12;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - фінанси недоступні');
  return env.DB;
}

/**
 * Київська північ доби, до якої належить момент. Секунди й мілісекунди
 * зрізаємо теж: `kyivMinuteOfDay` дає цілі хвилини, тож без цього «північ»
 * виходила б о 00:00:37 - і покупка о 00:00:20 випадала б із «сьогодні».
 * @param {number} nowMs
 */
export function kyivDayStartMs(nowMs) {
  return nowMs - kyivMinuteOfDay(new Date(nowMs)) * 60_000 - (nowMs % 60_000);
}

/** Скільки діб від понеділка (київський тиждень). @param {number} nowMs */
function kyivWeekdayIndex(nowMs) {
  const dow = new Date(`${kyivDateKey(new Date(nowMs))}T00:00:00Z`).getUTCDay();
  return (dow + 6) % 7; // неділя (0) → 6
}

/**
 * @typedef {{ from: string, to: string, label: string, prevFrom: string, prevTo: string }} Period
 */

/**
 * Розбір періоду (07 §4): `день`·`вчора`·`тиждень`·`місяць`, `Nd`/`Nw`/`Nm`,
 * `YYYY-MM`, `YYYY-MM-DD..YYYY-MM-DD`. Невідоме - явна помилка, не тихий
 * дефолт: «за тиждень» замість «за місяць» - це інша відповідь.
 * @param {string} raw @param {number} nowMs @returns {Period}
 */
export function resolvePeriod(raw, nowMs) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  const dayStart = kyivDayStartMs(nowMs);
  /** @type {[number, number, string] | null} */
  let win = null;

  if (/^(день|сьогодні|today|1d)$/.test(text)) {
    win = [dayStart, nowMs, 'сьогодні'];
  } else if (/^(вчора|yesterday)$/.test(text)) {
    win = [dayStart - 86_400_000, dayStart, 'учора'];
  } else if (/^(тиждень|week|1w)$/.test(text)) {
    win = [dayStart - kyivWeekdayIndex(nowMs) * 86_400_000, nowMs, 'цей тиждень'];
  } else if (/^(місяць|month|1m)$/.test(text)) {
    win = [monthStartMs(nowMs), nowMs, 'цей місяць'];
  } else {
    const rel = text.match(/^(\d{1,3})([dwm])$/);
    const month = text.match(/^(\d{4})-(\d{2})$/);
    const range = text.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    if (rel) {
      const n = Number(rel[1]);
      if (!(n > 0)) throw new Error(`finance: період «${raw}» порожній`);
      const days = rel[2] === 'd' ? n : rel[2] === 'w' ? n * 7 : n * 30;
      win = [dayStart - (days - 1) * 86_400_000, nowMs, `останні ${days} діб`];
    } else if (month) {
      const ym = `${month[1]}-${month[2]}`;
      const start = monthKeyStartMs(ym, 0);
      const end = monthKeyStartMs(ym, 1);
      win = [start, end, `${month[1]}-${month[2]}`];
    } else if (range) {
      const from = dayKeyToMs(/** @type {string} */ (range[1]));
      const to = dayKeyToMs(/** @type {string} */ (range[2])) + 86_400_000;
      if (!(to > from)) throw new Error(`finance: період «${raw}» порожній`);
      win = [from, to, `${range[1]}…${range[2]}`];
    }
  }
  if (!win) {
    throw new Error(
      `finance: період «${raw}» не розібрано; підтримані - день, вчора, тиждень, місяць, Nd/Nw/Nm, YYYY-MM, YYYY-MM-DD..YYYY-MM-DD`,
    );
  }
  const [from, to, label] = win;
  const span = to - from;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    label,
    prevFrom: new Date(from - span).toISOString(),
    prevTo: new Date(from).toISOString(),
  };
}

/** Київська північ 1-го числа місяця, до якого належить момент. @param {number} nowMs */
export function monthStartMs(nowMs) {
  return dayKeyToMs(`${kyivDateKey(new Date(nowMs)).slice(0, 7)}-01`);
}

/** YYYY-MM-DD → мс київської півночі цієї доби. @param {string} key */
function dayKeyToMs(key) {
  return Date.parse(`${key}T00:00:00Z`) + tzOffsetMs(key);
}

/**
 * Зсув Києва для конкретної доби у мс (літній/зимовий час). Рахуємо через
 * Intl, а не константою +2/+3: доба переведення годинника інакше зʼїхала б.
 * @param {string} key - YYYY-MM-DD
 */
function tzOffsetMs(key) {
  const utcNoon = Date.parse(`${key}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcNoon));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
  return -(hour - 12) * 3_600_000;
}

/**
 * Київська північ 1-го числа місяця, зсунутого на `months` від `YYYY-MM`.
 * Рахуємо за КЛЮЧЕМ, а не за мс: зворотне перетворення в UTC зʼїжджає на добу
 * (київська північ 01.09 - це 31.08 в UTC, і «місяць» ставав серпнем).
 * @param {string} ym - YYYY-MM @param {number} months
 */
function monthKeyStartMs(ym, months) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  const total = year * 12 + (month - 1) + months;
  const key = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  return dayKeyToMs(key);
}

/**
 * @typedef {{ id: string, at: string, amount: number, currency: string,
 *   amount_uah: number | null, mcc: number, merchant: string, category: string,
 *   flags: string[], note: string | null }} QueryTx
 */

/**
 * Списання вікна (зарахування у витрати не входять). `category` і `merchant` -
 * фільтри без регістру; `flags` - усі перелічені мають бути на транзакції.
 * @param {Env} env
 * @param {{ from: string, to: string, category?: string, merchant?: string, flags?: string[] }} q
 * @returns {Promise<QueryTx[]>}
 */
export async function selectSpending(env, q) {
  const { results } = await db(env)
    .prepare(
      `SELECT id, at, amount, currency, amount_uah, mcc, description, category, flags_json, note
       FROM transactions
       WHERE at >= ? AND at < ? AND amount < 0 AND ${NOT_TEST_SQL}
       ORDER BY at DESC LIMIT 5000`,
    )
    .bind(q.from, q.to)
    .all();
  const catKey = q.category ? String(q.category).trim().toLowerCase() : null;
  const merKey = q.merchant ? merchantKey(q.merchant) : null;
  const want = (q.flags ?? []).filter(Boolean);
  /** @type {QueryTx[]} */
  const out = [];
  for (const r of results ?? []) {
    const category = String(r.category ?? '');
    if (catKey && category.toLowerCase() !== catKey) continue;
    const merchant = String(r.description ?? '');
    if (merKey && !merchantKey(merchant).includes(merKey)) continue;
    /** @type {string[]} */
    let flags;
    try {
      flags = JSON.parse(String(r.flags_json ?? '[]'));
    } catch {
      flags = [];
    }
    if (want.length && !want.every((f) => flags.includes(f))) continue;
    out.push({
      id: String(r.id),
      at: String(r.at),
      amount: Number(r.amount),
      currency: String(r.currency ?? ''),
      amount_uah: r.amount_uah == null ? null : Number(r.amount_uah),
      mcc: Number(r.mcc ?? 0),
      merchant,
      category,
      flags,
      note: r.note == null ? null : String(r.note),
    });
  }
  return out;
}

/**
 * Зведення вікна: сума (додатна, у копійках), кількість, розрізи.
 * @param {QueryTx[]} rows
 */
export function summarize(rows) {
  let total = 0;
  let unconverted = 0;
  /** @type {Map<string, { total: number, n: number }>} */
  const byCategory = new Map();
  /** @type {Map<string, { name: string, total: number, n: number }>} */
  const byMerchant = new Map();
  for (const r of rows) {
    if (r.amount_uah == null) {
      unconverted += 1;
      continue;
    }
    const value = Math.abs(r.amount_uah);
    total += value;
    const cat = byCategory.get(r.category) ?? { total: 0, n: 0 };
    cat.total += value;
    cat.n += 1;
    byCategory.set(r.category, cat);
    const key = merchantKey(r.merchant) || r.merchant;
    const mer = byMerchant.get(key) ?? { name: r.merchant, total: 0, n: 0 };
    mer.total += value;
    mer.n += 1;
    byMerchant.set(key, mer);
  }
  const sort = (/** @type {{ total: number }} */ a, /** @type {{ total: number }} */ b) =>
    b.total - a.total;
  return {
    n: rows.length,
    total_uah: total,
    unconverted,
    by_category: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort(sort)
      .slice(0, BREAKDOWN_MAX),
    by_merchant: [...byMerchant.values()].sort(sort).slice(0, BREAKDOWN_MAX),
  };
}

/**
 * Довідка по мерчанту для режиму `id` (finance.md крок 3): скільки операцій за
 * 24 міс, остання сума й дата.
 * @param {Env} env @param {string} merchant @param {string} beforeIso
 */
export async function merchantReference(env, merchant, beforeIso) {
  const key = merchantKey(merchant);
  if (!key) return { name: merchant, count_24m: 0, last_amount: null, last_at: null };
  const fromIso = new Date(Date.parse(beforeIso) - 24 * 30 * 86_400_000).toISOString();
  const { results } = await db(env)
    .prepare(
      `SELECT at, amount, currency, description FROM transactions
       WHERE at >= ? AND at < ? AND ${NOT_TEST_SQL} ORDER BY at DESC LIMIT 5000`,
    )
    .bind(fromIso, beforeIso)
    .all();
  const mine = (results ?? []).filter((r) => merchantKey(r.description) === key);
  const last = mine[0];
  return {
    name: merchant,
    count_24m: mine.length,
    last_amount: last ? Number(last.amount) : null,
    last_currency: last ? String(last.currency ?? '') : null,
    last_at: last ? String(last.at) : null,
  };
}
