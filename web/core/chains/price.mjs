// PriceTrack (07 §6, S-5-11/S-5-12, етап 5 PR-3): ланцюг «відстежуй ціну»
// для бажання purchase з url. Щодня - прогін профілю `price-check` у мозку
// (інструкція Дослідника, WebSearch/WebFetch), його звіт «## Ціни» парсить
// ядро → price_points; ціна ≤ target або на ≥ 5 % нижча за попередню -
// повідомлення з кнопкою «Стоп». Один тип події `price` з action stop/cancel
// (від кнопки, wishes.update(status) чи chain.cancel) і подія `worker` від
// мозку (/internal/runs outcome.chain). Мозок недоступний або звіт без ціни -
// пропуск дня з логом, три поспіль - алерт у TOPIC_SYSTEM (S-5-12). Імена
// кроків - з індексом дня: Workflow відтворює код з початку після кожного
// пробудження. Через 180 днів - завершення з повідомленням.
//
// Звіт Дослідника - зовнішній вміст (сторінки магазинів): у повідомлення
// власнику йде лише ціна у валюті бажання, назва магазину без розмітки і
// URL з хоста бажання або відомих магазинів (security-ревʼю етапу 5:
// сторінка не сміє підкинути фішинг-посилання під іменем магазину).
// Бажання читається СВІЖИМ щодня: wishes.update міг змінити url, ціль або
// зупинити відстеження.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox, sendSystemAlert } from '../tg/outbox.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { startChainWorkerRun } from '../brain/chain-worker.mjs';
import { runFactsGet } from '../tools/facts.mjs';
import { patchChainState, readChainState, waitOrNull } from './state.mjs';
import { sendChainEvent } from './registry.mjs';
import { chainTarget } from './table.mjs';

export const CHAIN_KIND = 'price';
export const PRICE_CHECK_PROFILE = 'price-check';
/** Інструкція профілю - Дослідник (07 §5 price-check → agents/researcher.md). */
export const PRICE_CHECK_INSTRUCTION = 'researcher';
const PRICE_CHECK_MODEL = 'claude-sonnet-5';
/** Звіт Дослідника: профіль 8 хв + черга мозку; сторож прогону - довший. */
export const WAIT_CHECK_MS = 12 * 60_000;
const CHECK_RUN_STALE_MS = WAIT_CHECK_MS + 3 * 60_000;
/** Мозок зайнятий (429 busy) або впав - друга спроба через 5 хв, далі пропуск дня. */
const RETRY_MS = 5 * 60_000;
const START_ATTEMPTS = 2;
export const DAY_MS = 24 * 3_600_000;
/** Стеля днів відстеження: далі - повідомлення й done (власник поновлює словом). */
export const MAX_DAYS = 180;
/** Поріг «ціна впала» (S-5-11: −5 %). */
export const DROP_RATIO = 0.05;
/** Пропусків поспіль до алерту (S-5-12: «3 дні поспіль - алерт»). */
export const MISSES_ALERT = 3;
export const PRICE_TRACK_KICK_MARKER_KEY = 'priceTrackKickDay';
const PRICE_TRACK_KICK_HOUR = 9;
/** Магазини за замовчуванням; власник змінює через facts.setting.price_shops. */
export const DEFAULT_SHOPS = [
  'rozetka.com.ua',
  'comfy.ua',
  'allo.ua',
  'foxtrot.com.ua',
  'eldorado.ua',
];

/**
 * @typedef {{ source: string, price: number, currency: string, in_stock: boolean, url: string | null }} PricePoint
 * @typedef {{ url: string, target_price: number | null, currency: string, active: boolean, shops: string[] }} WishSnapshot
 * @typedef {{
 *   now: () => number,
 *   wish: () => Promise<WishSnapshot | null>,
 *   startCheck: (task: string) => Promise<boolean>,
 *   send: (text: string, buttons?: { text: string, callback_data: string }[][]) => Promise<void>,
 *   alert: (text: string) => Promise<void>,
 * }} PriceIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} PriceStep
 * @typedef {{ wish_id: string, title: string, url: string, target_price: number | null, currency: string,
 *   chat_id: number | string | null, thread_id: string | null, awaiting: string | null, misses?: number }} PriceState
 * @typedef {{ chainId: string, state?: PriceState }} PriceParams
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - ланцюг недоступний');
  return env.DB;
}

// ── Гроші й звіт Дослідника ────────────────────────────────────────────────

const CURRENCY_LABEL = /** @type {Record<string, string>} */ ({
  UAH: 'грн',
  USD: '$',
  EUR: '€',
  PLN: 'zł',
});

/** 329950 UAH → «3 299,50 грн»; 329900 → «3 299 грн». @param {number} minor @param {string} currency */
export function formatMoney(minor, currency) {
  const abs = Math.abs(Math.round(minor));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = abs % 100;
  const num = `${minor < 0 ? '−' : ''}${whole}${cents ? `,${String(cents).padStart(2, '0')}` : ''}`;
  // Object.hasOwn: валюта приходить із чужих API, і «constructor» витягнув
  // би функцію з прототипу прямо в текст власнику.
  const label = Object.hasOwn(CURRENCY_LABEL, currency) ? CURRENCY_LABEL[currency] : currency;
  return `${num} ${label}`;
}

const CURRENCY_TOKENS = /** @type {[RegExp, string][]} */ ([
  [/грн|uah|₴/i, 'UAH'],
  [/\$|usd/i, 'USD'],
  [/€|eur/i, 'EUR'],
  [/zł|pln/i, 'PLN'],
]);

/**
 * Число в основних одиницях із тексту ціни: «3 299», «3.299» (крапка -
 * роздільник тисяч), «3299.50», «3 299,50», «1.099,00». null - не число.
 * Плутанина тисячника з копійками коштувала б «−99 %» у повідомленні й
 * зіпсованого мінімуму в price_points, тож розбір явний, не Number().
 * @param {string} text
 */
export function parseAmount(text) {
  const raw = String(text ?? '')
    .replace(/\s/g, '')
    .match(/\d+(?:[.,]\d+)*/)?.[0];
  if (!raw) return null;
  // Останній роздільник із 1-2 цифрами після нього - копійки; решта - тисячі.
  const m = raw.match(/[.,](\d{1,2})$/);
  const cents = m ? m[1] : null;
  const whole = (cents == null ? raw : raw.slice(0, -(cents.length + 1))).replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole)) return null;
  const n = Number(cents == null ? whole : `${whole}.${cents}`);
  return Number.isFinite(n) ? n : null;
}

/** «3 299 грн» / «3.299 грн» / «$12,99» → {price (копійки), currency}; null - не ціна. @param {string} text */
export function parsePrice(text) {
  const currency = CURRENCY_TOKENS.find(([re]) => re.test(text))?.[1] ?? null;
  const n = parseAmount(text);
  if (n == null || n <= 0 || !currency) return null;
  return { price: Math.round(n * 100), currency };
}

/** Хост URL; null - не http(s). @param {string} url */
function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Хост належить дозволеному домену (сам домен або піддомен). @param {string} host @param {string[]} allowed */
export function hostAllowed(host, allowed) {
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Назва магазину без розмітки й посилань: [текст](url) → текст, голі URL геть. @param {string} s */
export function cleanSource(s, max = 40) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[^\p{L}\p{N} .'&-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Розділ «## Ціни» звіту Дослідника (researcher.md «Формат відповіді»):
 * «- <Магазин> - <ціна> <валюта> - <наявність> - <дата> - <URL>». Поля
 * читаються з ХВОСТА (URL, дата), далі перше поле з валютою - ціна, усе до
 * неї - назва магазину (у ній буває « - »). Лишаються лише ціни у валюті
 * бажання (інакше «найдешевша» вийшла б у чужій валюті); URL - лише з
 * дозволених хостів. Від найнижчої.
 * @param {string} text
 * @param {{ currency: string, allowedHosts: string[] }} opts
 * @returns {PricePoint[]}
 */
export function parsePriceReport(text, opts) {
  const lines = String(text ?? '').split(/\r?\n/);
  const from = lines.findIndex((l) => /^##\s*Ціни/i.test(l.trim()));
  if (from < 0) return [];
  /** @type {PricePoint[]} */
  const out = [];
  for (const raw of lines.slice(from + 1)) {
    const line = raw.trim();
    if (/^##\s/.test(line)) break;
    if (!line.startsWith('-')) continue;
    const tail = line
      .replace(/^-\s*/, '')
      .split(/\s+-\s+/)
      .map((p) => p.trim());
    if (tail.length < 3) continue;
    const urlPart = /^https?:\/\//i.test(tail[tail.length - 1] ?? '') ? tail.pop() : null;
    if (tail.length >= 3 && /\d{1,2}\.\d{2}\.\d{4}|відкрито/i.test(tail[tail.length - 1] ?? '')) {
      tail.pop();
    }
    const priceIdx = tail.findIndex((p, i) => i > 0 && parsePrice(p) != null);
    if (priceIdx < 0) continue;
    const parsed = /** @type {{ price: number, currency: string }} */ (
      parsePrice(tail[priceIdx] ?? '')
    );
    if (parsed.currency !== opts.currency) continue;
    const source = cleanSource(tail.slice(0, priceIdx).join(' - ')) || 'магазин';
    const availability = tail[priceIdx + 1] ?? '';
    const host = urlPart ? hostOf(urlPart) : null;
    out.push({
      source,
      price: parsed.price,
      currency: parsed.currency,
      in_stock: !/нема|відсутн|unknown|під замовлення/i.test(availability),
      url: urlPart && host && hostAllowed(host, opts.allowedHosts) ? urlPart.slice(0, 500) : null,
    });
  }
  return out.sort((a, b) => a.price - b.price);
}

/** Найкраща ціна: найнижча з наявних, інакше найнижча взагалі. @param {PricePoint[]} points */
export function pickBest(points) {
  return points.find((p) => p.in_stock) ?? points[0] ?? null;
}

/** Задача Дослідникові (researcher.md «Що отримує»). @param {string} title @param {WishSnapshot} wish */
export function checkTask(title, wish) {
  return (
    `Ціна товару «${title}» - спершу сторінка ${wish.url}, далі ті самі товар/модель у магазинах ` +
    `(${wish.shops.join(', ')}): ціна як на сторінці, валюта, наявність, дата, URL. ` +
    `Лише ціни з відкритих сторінок, без прогнозів і без конвертації.`
  );
}

/** Дозволені хости посилань зі звіту: хост url бажання + магазини. @param {WishSnapshot} wish */
export function allowedHostsOf(wish) {
  const own = hostOf(wish.url);
  return [...(own ? [own] : []), ...wish.shops];
}

// ── Старт / зупинка ────────────────────────────────────────────────────────

/**
 * Активний ланцюг ціни: за id ланцюга, за бажанням або найсвіжіший.
 * @param {Env} env @param {{ chainId?: string | null, wishId?: string | null }} q
 */
export async function findActivePriceChain(env, q) {
  const row = /** @type {{ id: string, state_json: string } | null} */ (
    await db(env)
      .prepare(
        `SELECT id, state_json FROM chains WHERE kind = ? AND status IN ('running', 'waiting')
           AND (? IS NULL OR id = ?) AND (? IS NULL OR json_extract(state_json, '$.wish_id') = ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(CHAIN_KIND, q.chainId ?? null, q.chainId ?? null, q.wishId ?? null, q.wishId ?? null)
      .first()
  );
  if (!row) return null;
  let title = '';
  let wishId = '';
  try {
    const st = JSON.parse(row.state_json ?? '{}');
    title = String(st?.title ?? '');
    wishId = String(st?.wish_id ?? '');
  } catch {
    /* битий стан - назви немає */
  }
  return { id: String(row.id), title, wishId };
}

/** Текст після старту - один для wishes.create і chain.start. @param {string} title @param {number | null} target @param {string} currency */
export function trackingText(title, target, currency) {
  return `Відстежую ціну «${title}» щодня; скажу при −5 % або ${target != null ? `≤ ${formatMoney(target, currency)}` : 'цільовій ціні'}.`;
}

/**
 * Старт ланцюга для бажання (S-5-11). Активний уже є - повертає його
 * (дедуп: другий Workflow слав би дві перевірки на день).
 * @param {Env} env
 * @param {{ id: string, title: string, url: string, target_price: number | null, currency: string }} wish
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 */
export async function startPriceTrack(env, wish, nowMs, ctx) {
  if (!env.PRICE_TRACK) throw new Error('привʼязки PRICE_TRACK (Workflow) немає');
  const existing = await findActivePriceChain(env, { wishId: wish.id });
  if (existing) return { chainId: existing.id, existing: true };
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  /** @type {PriceState} */
  const state = {
    wish_id: wish.id,
    title: wish.title,
    url: wish.url,
    target_price: wish.target_price ?? null,
    currency: wish.currency,
    chat_id: ctx.chatId ?? null,
    thread_id: ctx.threadId == null ? null : String(ctx.threadId),
    awaiting: null,
    misses: 0,
  };
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(chainId, CHAIN_KIND, chainId, JSON.stringify(state), iso, iso)
    .run();
  try {
    await env.PRICE_TRACK.create({ id: chainId, params: { chainId } });
  } catch (/** @type {any} */ e) {
    await patchChainState(env, chainId, 'failed', { awaiting: null }, { nowMs });
    throw new Error(`Workflow відстеження не стартував: ${String(e?.message ?? e)}`, { cause: e });
  }
  return { chainId, existing: false };
}

/**
 * Зупинка (кнопка «Стоп», wishes.update(status), chain.cancel, «↩»): один
 * UPDATE за бажанням → cancelled + подія stop; не доставилась - машина
 * побачить cancelled на наступному записі стану. false - активного немає.
 * @param {Env} env @param {string} wishId @param {number} nowMs
 */
export async function cancelPriceTrack(env, wishId, nowMs) {
  const { results } = await db(env)
    .prepare(
      `UPDATE chains SET status = 'cancelled', updated_at = ? WHERE kind = ? AND status IN ('running', 'waiting')
         AND json_extract(state_json, '$.wish_id') = ? RETURNING id`,
    )
    .bind(new Date(nowMs).toISOString(), CHAIN_KIND, wishId)
    .all();
  const ids = (results ?? []).map((r) => String(r.id));
  for (const id of ids) await notifyStop(env, id);
  return ids.length > 0;
}

/** @param {Env} env @param {string} chainId @param {number} nowMs */
export async function cancelPriceChain(env, chainId, nowMs) {
  const { meta } = await db(env)
    .prepare(
      `UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ? AND kind = ? AND status IN ('running', 'waiting')`,
    )
    .bind(new Date(nowMs).toISOString(), chainId, CHAIN_KIND)
    .run();
  if (!meta?.changes) return false;
  await notifyStop(env, chainId);
  return true;
}

/** @param {Env} env @param {string} chainId */
async function notifyStop(env, chainId) {
  try {
    await sendChainEvent(env, chainId, 'price', { action: 'stop' });
  } catch (/** @type {any} */ e) {
    console.error(
      `price-track ${chainId}: подія stop не доставлена (закриє наступний запис стану)`,
      e?.message,
    );
  }
}

/** @param {Env} env @param {string} chainId @returns {Promise<PriceState>} */
export async function loadPriceState(env, chainId) {
  const row = await readChainState(env, chainId);
  if (!row) throw new Error(`ланцюга ${chainId} немає`);
  return /** @type {PriceState} */ (row.state);
}

/**
 * Свіжий знімок бажання: url/ціль/валюту міг змінити wishes.update після
 * старту ланцюга, а «стоп відстежувати» - status. null - бажання немає.
 * @param {Env} env @param {string} wishId
 * @returns {Promise<WishSnapshot | null>}
 */
export async function readWishSnapshot(env, wishId) {
  const row = /** @type {{ status: string, payload_json: string | null } | null} */ (
    await db(env)
      .prepare('SELECT status, payload_json FROM wishes WHERE id = ?')
      .bind(wishId)
      .first()
  );
  if (!row) return null;
  /** @type {Record<string, any>} */
  let payload;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    console.error(`price-track: битий payload_json бажання ${wishId}`);
    payload = {};
  }
  return {
    url: typeof payload.url === 'string' ? payload.url : '',
    target_price: typeof payload.target_price === 'number' ? payload.target_price : null,
    currency: String(payload.currency ?? 'UAH'),
    active: row.status === 'active',
    shops: await shopsOf(env),
  };
}

/** Магазини для пошуку: facts.setting.price_shops (масив доменів) або типові. @param {Env} env */
export async function shopsOf(env) {
  try {
    const fact = /** @type {any} */ (
      (await runFactsGet(env, { kind: 'setting', key: 'price_shops' })).result[0]
    );
    const list = Array.isArray(fact?.value) ? fact.value : fact?.value?.shops;
    if (Array.isArray(list) && list.length) {
      return list
        .map((s) => String(s).toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 10);
    }
  } catch (/** @type {any} */ e) {
    console.error('price-track: facts.setting.price_shops не прочитано', e?.message);
  }
  return DEFAULT_SHOPS;
}

// ── Машина станів ──────────────────────────────────────────────────────────

class Stopped extends Error {}

/**
 * Записати точку ціни; is_low = не вище за мінімум досі. Повертає попередню
 * і найнижчу ціну ДО запису (лише в тій самій валюті - інакше пороги
 * порівнювали б гривні з доларами).
 * @param {Env} env @param {string} wishId @param {PricePoint} p @param {number} nowMs
 */
export async function savePricePoint(env, wishId, p, nowMs) {
  const stats = /** @type {{ last_price: number | null, min_price: number | null } | null} */ (
    await db(env)
      .prepare(
        `SELECT (SELECT price FROM price_points WHERE wish_id = ? AND currency = ? ORDER BY at DESC LIMIT 1) AS last_price,
                (SELECT MIN(price) FROM price_points WHERE wish_id = ? AND currency = ?) AS min_price`,
      )
      .bind(wishId, p.currency, wishId, p.currency)
      .first()
  );
  const prev = stats?.last_price == null ? null : Number(stats.last_price);
  const min = stats?.min_price == null ? null : Number(stats.min_price);
  const isLow = min == null || p.price <= min;
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
      isLow ? 1 : 0,
    )
    .run();
  return { prev, min, isLow };
}

/**
 * Що сказати власнику (null - мовчати): перша ціна - один раз; далі лише
 * ≤ target або падіння ≥ 5 % проти попередньої перевірки.
 * @param {string} title @param {number | null} target @param {PricePoint} best
 * @param {{ prev: number | null, min: number | null }} stats
 */
export function priceVerdict(title, target, best, stats) {
  const money = (/** @type {number} */ v) => formatMoney(v, best.currency);
  const where = `${best.source}${best.url ? `: ${best.url}` : ''}`;
  if (stats.prev == null) {
    return `Перша ціна «${title}»: ${money(best.price)} (${where}). Стежу далі.`;
  }
  if (target != null && best.price <= target) {
    return `🎯 «${title}» - ${money(best.price)}, не дорожче цільових ${money(target)} (${where}).`;
  }
  if (best.price <= stats.prev * (1 - DROP_RATIO)) {
    const pct = Math.round((1 - best.price / stats.prev) * 100);
    return `📉 «${title}» подешевшало: ${money(best.price)} (−${pct} % від ${money(stats.prev)}${stats.min != null && best.price <= stats.min ? ', мінімум за весь час' : ''}) - ${where}.`;
  }
  return null;
}

/**
 * @param {Env} env
 * @param {PriceParams} params
 * @param {PriceStep} step
 * @param {PriceIo} io
 */
export async function runPriceTrack(env, params, step, io) {
  const { chainId } = params;
  const state = params.state ?? (await step.do('state', () => loadPriceState(env, chainId)));
  const stopBtn = [[{ text: '⏹ Стоп', callback_data: `c:${chainId}:stop` }]];
  /** Запис стану, що шанує cancelled (зупинка без доставленої події). @param {string} label @param {'running' | 'waiting'} status @param {Record<string, unknown>} patch */
  const write = async (label, status, patch) => {
    const ok = await step.do(label, () =>
      patchChainState(env, chainId, status, patch, { unlessCancelled: true, nowMs: io.now() }),
    );
    if (!ok) throw new Stopped();
  };
  let misses = Number(state.misses) || 0;
  try {
    for (let d = 0; d < MAX_DAYS; d += 1) {
      const label = `d${d}`;
      // Свіже бажання: url/ціль могли змінитись, «стоп відстежувати» - status.
      const wish = await step.do(`${label}-wish`, () => io.wish());
      if (!wish || !wish.active || !wish.url) throw new Stopped();
      const task = checkTask(state.title, wish);
      let started = false;
      for (let a = 0; a < START_ATTEMPTS && !started; a += 1) {
        started = await step.do(`${label}-start-${a}`, () => io.startCheck(task));
        if (!started && a + 1 < START_ATTEMPTS) {
          // Мозок зайнятий (429) чи впав - друга спроба; «Стоп» будить одразу.
          const ev = await waitOrNull(step, `${label}-retry-${a}`, 'price', RETRY_MS);
          if (ev?.action === 'stop' || ev?.action === 'cancel') throw new Stopped();
        }
      }
      const ev = started ? await waitOrNull(step, `${label}-wait`, 'worker', WAIT_CHECK_MS) : null;
      // «Стоп» під час очікування звіту (подія іншого типу) видно тут - ДО
      // запису ціни й повідомлення, тобто зупинений ланцюг більше не пише.
      await write(`${label}-run`, 'running', { awaiting: null, day: d });
      const report = typeof ev?.output === 'string' ? ev.output : '';
      const best = pickBest(
        parsePriceReport(report, { currency: wish.currency, allowedHosts: allowedHostsOf(wish) }),
      );
      if (best) {
        misses = 0;
        const stats = await step.do(`${label}-save`, () =>
          savePricePoint(env, state.wish_id, best, io.now()),
        );
        const verdict = priceVerdict(state.title, wish.target_price, best, stats);
        if (verdict) await step.do(`${label}-notify`, () => io.send(verdict, stopBtn));
      } else {
        misses += 1;
        console.error(
          `price-track ${chainId}: день ${d} без ціни у ${wish.currency} (${started ? (ev ? 'звіт без придатних «## Ціни»' : 'мозок не відповів') : 'прогін не стартував'})`,
        );
        if (misses === MISSES_ALERT) {
          await step.do(`${label}-alert`, () =>
            io.alert(
              `Відстеження ціни «${state.title}»: ${MISSES_ALERT} дні поспіль без ціни (мозок/Дослідник). Ланцюг живе, перевірю завтра.`,
            ),
          );
        }
      }
      // Доба - як очікування події stop: кнопка або chain.cancel будять одразу.
      await write(`${label}-sleep-state`, 'waiting', { awaiting: null, misses });
      const stop = await waitOrNull(step, `${label}-sleep`, 'price', DAY_MS);
      if (stop?.action === 'stop' || stop?.action === 'cancel') throw new Stopped();
    }
    await step.do('expire-state', () =>
      patchChainState(env, chainId, 'done', { awaiting: null }, { nowMs: io.now() }),
    );
    await step.do('expire-text', () =>
      io.send(
        `Відстеження «${state.title}» завершено після ${MAX_DAYS} днів. Скажи «відстежуй далі», якщо ще актуально.`,
      ),
    );
    return { outcome: 'expired' };
  } catch (e) {
    if (e instanceof Stopped) {
      await step.do('stopped-state', () =>
        patchChainState(env, chainId, 'cancelled', { awaiting: null }, { nowMs: io.now() }),
      );
      await step.do('stopped-text', () => io.send(`Зупинив відстеження «${state.title}».`));
      return { outcome: 'cancelled' };
    }
    throw e;
  }
}

// ── Бойове io ──────────────────────────────────────────────────────────────

/**
 * Прогін профілю price-check у мозку: інструкція Дослідника з D1, вхід JSON
 * {chain_id, mode, task, format}; результат повернеться подією `worker`.
 * @param {Env} env @param {{ chainId: string, task: string }} req @param {number} nowMs
 */
export function startPriceCheckRun(env, req, nowMs) {
  return startChainWorkerRun(
    env,
    {
      profile: PRICE_CHECK_PROFILE,
      instruction: PRICE_CHECK_INSTRUCTION,
      model: PRICE_CHECK_MODEL,
      input: { chain_id: req.chainId, mode: 'price', task: req.task, format: 'chat' },
      staleMs: CHECK_RUN_STALE_MS,
      log: 'price-track',
    },
    nowMs,
  );
}

/**
 * @param {Env} env @param {string} chainId @param {PriceState} state
 * @returns {PriceIo}
 */
export function productionIo(env, chainId, state) {
  const { chatId, threadId } = chainTarget(env, state);
  return {
    now: () => Date.now(),
    wish: () => readWishSnapshot(env, state.wish_id),
    startCheck: (task) => startPriceCheckRun(env, { chainId, task }, Date.now()),
    send: async (text, btns) => {
      await enqueueOutbox(
        env,
        {
          chatId,
          threadId,
          kind: 'send',
          parts: renderMdParts(text),
          payload: btns ? { reply_markup: { inline_keyboard: btns } } : {},
        },
        Date.now(),
      );
      await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
        console.error(`price-track ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
      });
    },
    alert: async (text) => void (await sendSystemAlert(env, text, Date.now())),
  };
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class PriceTrack extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<PriceParams>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {PriceParams} */ (event.payload);
    try {
      const state = await step.do('state', () => loadPriceState(env, params.chainId));
      return await runPriceTrack(
        env,
        { ...params, state },
        step,
        productionIo(env, params.chainId, state),
      );
    } catch (/** @type {any} */ e) {
      console.error(`price chain ${params.chainId} впав`, e?.message);
      await patchChainState(env, params.chainId, 'failed', { awaiting: null }).catch(
        (/** @type {any} */ e2) =>
          console.error(`price chain ${params.chainId}: статус failed не записано`, e2?.message),
      );
      throw e;
    }
  }
}

// ── Задача price-track-kick (07 §7) ────────────────────────────────────────

/**
 * Щодня о 09:00 Києва: активні бажання purchase з url, у яких ланцюга ще НЕ
 * БУЛО або він упав (failed) → старт. Зупинені власником (cancelled) чи
 * завершені (done) НЕ поновлюються: інакше кнопка «Стоп» діяла б до ранку.
 * Мітка доби в KV.
 * @param {Env} env @param {number} [nowMs]
 */
export async function priceTrackKickTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== PRICE_TRACK_KICK_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(PRICE_TRACK_KICK_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB || !env.PRICE_TRACK) return { skipped: 'no-binding' };
  const { results } = await db(env)
    .prepare(
      `SELECT w.id, w.title, json_extract(w.payload_json, '$.url') AS url,
              json_extract(w.payload_json, '$.target_price') AS target_price,
              json_extract(w.payload_json, '$.currency') AS currency
       FROM wishes w
       WHERE w.type = 'purchase' AND w.status = 'active' AND json_extract(w.payload_json, '$.url') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM chains c WHERE c.kind = ?
                           AND c.status IN ('running', 'waiting', 'cancelled', 'done')
                           AND json_extract(c.state_json, '$.wish_id') = w.id)`,
    )
    .bind(CHAIN_KIND)
    .all();
  const started = [];
  for (const r of results ?? []) {
    try {
      const out = await startPriceTrack(
        env,
        {
          id: String(r.id),
          title: String(r.title ?? ''),
          url: String(r.url),
          target_price: r.target_price == null ? null : Number(r.target_price),
          currency: String(r.currency ?? 'UAH'),
        },
        nowMs,
        {},
      );
      started.push(out.chainId);
    } catch (/** @type {any} */ e) {
      console.error(`price-track-kick: бажання ${String(r.id)} не стартувало`, e?.message);
    }
  }
  await env.BRIEFING.put(PRICE_TRACK_KICK_MARKER_KEY, today);
  return { started: started.length };
}
