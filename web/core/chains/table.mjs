// TableChain (07 §6, S-1-1…S-1-15, етап 5 PR-2): ланцюг «столик» - від
// «нагадай забронювати столик у Креденс о 14:00» до «Як було?». Старт з чату
// (chain.start kind=table через policy, T0 з «↩»): кандидати з кешу `places`
// (модель шукала places.search) або власний пошук, час нагадування рахує
// ядро (parseReminderTime), рядок у `chains` + інстанс Workflow (id = chainId).
//
// Машина станів runTableChain(env, params, step, io): усі кроки через
// step.do, очікування - ОДИН тип події `table` з payload.action (кнопки
// c:<id>:<choice> і текст власника перекладає chains/registry.mjs; так
// `cancel` приходить у будь-яке очікування без другого механізму), вихід у
// світ - через io. Імена кроків ДЕТЕРМІНОВАНІ: фіксовані для одноразових
// стадій і з індексом ітерації всередині кожного циклу - Workflows
// відтворює код з початку після кожного пробудження, і лічильник, який
// залежить від часу, дав би інші імена, ніж при першому проході. Кожен
// побічний ефект - окремий step.do (повтор кроку не подвоює повідомлення).
// Тиша власника - штатний шлях: після 24 год ланцюг лишається waiting і
// мовчить (нагадування +5/+20 шле chain-nudge, мʼякий рядок - prerouter),
// через 7 днів без вибору - done без результату.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { parseReminderTime, addDaysToDateKey } from '../../reminders-core.mjs';
import { kyivClock, kyivDateKey } from '../../kyiv-time.mjs';
import { kyivMs } from '../day-plan/store.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import {
  Cancelled,
  chainTarget,
  db,
  patchChainState,
  postChainMessage,
  readChainState,
  waitOrNull,
} from './state.mjs';
import { sendChainEvent } from './registry.mjs';
import {
  placesSearch,
  placeDetails,
  routesEta,
  readPlace,
  PLACES_SEARCH_MAX,
} from '../adapters/maps.mjs';
import { QuotaExhaustedError } from '../quota/quota.mjs';
import { resolveWaypoint, modeWord } from '../tools/places.mjs';
import { runGeoLast } from '../tools/read.mjs';
import { runFactsGet } from '../tools/facts.mjs';
import { resolveAttendees } from '../../google.mjs';
// Лише функція (виклик у рантаймі): policy/proposals.mjs імпортує звідси
// виконавців chain.start/cancel - як ideas.mjs ↔ analysis.mjs.
import { applyPolicy } from '../policy/proposals.mjs';

export const CHAIN_KIND = 'table';
/** Очікування вибору закладу до тиші (07 §6: «Workflow сам чекає до 24 год»). */
export const WAIT_VENUE_MS = 24 * 3_600_000;
/** Після тиші - ще тиждень waiting, далі done без результату. */
export const QUIET_MAX_MS = 7 * 86_400_000;
/** Відповіді текстом/кнопками всередині одного стану. */
const WAIT_STEP_MS = 3_600_000;
/** «Пізніше» - повторити контакт через пів години. */
const LATER_MS = 30 * 60_000;
/** Локація з geo.last годиться для пошуку, поки їй ≤ 6 год (S-1-2). */
const GEO_FRESH_MS = 6 * 3_600_000;
/** Бронь без відомого часу: «Як було?» через стільки після нагадування. */
const UNKNOWN_BOOKING_SPAN_MS = 6 * 3_600_000;
/** Тривалість вечора для «Як було?» (07 §6: end + 2 год) і події запрошення. */
const BOOKING_SPAN_MS = 2 * 3_600_000;
const AFTER_END_MS = 2 * 3_600_000;
/** Запас до виходу поверх часу в дорозі (S-1-9: «+ 3 хв»). */
export const LEAVE_BUFFER_MIN = 3;
/** Нагадування «не натиснув кнопку» (S-1-6): +5 і ще раз через 15 (= +20). */
export const NUDGE_FIRST_MS = 5 * 60_000;
export const NUDGE_SECOND_MS = 15 * 60_000;
export const NUDGES_MAX = 2;
/** Стелі ітерацій циклів - для детермінованих імен кроків, не логіки. */
const VENUE_ROUNDS_MAX = 4;
const CONTACT_ROUNDS_MAX = 6;
const ACTIONS_MAX = 20;
const SLEEP_ROUNDS_MAX = 5;

/**
 * @typedef {{ text: string, callback_data?: string, url?: string }[][]} Keyboard
 * @typedef {{
 *   now: () => number,
 *   send: (text: string, buttons?: Keyboard) => Promise<void>,
 *   sendContact: (phone: string, name: string, buttons?: Keyboard) => Promise<void>,
 *   sendVenue: (lat: number, lon: number, title: string, address: string, buttons?: Keyboard) => Promise<void>,
 *   search: (query: string) => Promise<import('../adapters/maps.mjs').PlaceCandidate[]>,
 *   cached: (placeId: string) => Promise<import('../adapters/maps.mjs').PlaceDetails | null>,
 *   details: (placeId: string) => Promise<import('../adapters/maps.mjs').PlaceDetails | null>,
 *   eta: (to: { lat: number, lon: number } | { place_id: string } | { address: string }, mode: 'walk' | 'transit' | 'car', from: string, departAtMs: number | null) => Promise<{ duration_min: number, distance_m: number } | null>,
 *   propose: (kind: string, payload: Record<string, unknown>) => Promise<{ id: string, buttons: unknown } | null>,
 *   attendees: (names: string[]) => Promise<{ emails: string[], notes: string[] }>,
 *   defaultMode: () => Promise<'walk' | 'transit' | 'car' | null>,
 * }} TableIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   sleepUntil: (name: string, ms: number) => Promise<void>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} ChainStep
 * @typedef {{ chainId: string }} TableParams
 * @typedef {{
 *   venue: string, at: string, booking_at: string | null, city: string | null,
 *   candidates: string[], participants: string[], chat_id: number | string | null,
 *   thread_id: string | null, awaiting: string | null, awaiting_since?: string | null,
 *   nudge?: { at: string, n: number } | null, place_id?: string | null,
 *   manual?: { name: string, phone: string | null } | null, mode?: string | null,
 * }} TableState
 * @typedef {import('../adapters/maps.mjs').PlaceDetails} PlaceDetails
 * @typedef {import('../adapters/maps.mjs').PlaceCandidate} PlaceCandidate
 */

/** Ряд кнопок ланцюга (07 §9 `c:<id>:<choice>`). @param {string} chainId @param {[string, string][]} pairs */
function row(chainId, pairs) {
  return pairs.map(([text, choice]) => ({ text, callback_data: `c:${chainId}:${choice}` }));
}

/** Клавіатура кандидатів: назва · вулиця по одному в ряд + «Інший» + «✖». @param {string} chainId @param {PlaceCandidate[]} list */
export function venueKeyboard(chainId, list) {
  return [
    ...list
      .slice(0, PLACES_SEARCH_MAX)
      .map((p, i) => row(chainId, [[`${p.name}${streetOf(p.address)}`, `v${i}`]])),
    row(chainId, [
      ['Інший', 'vother'],
      ['✖ Скасувати', 'cancel'],
    ]),
  ];
}

// ── Старт з чату (виконавець chain.start kind=table) ───────────────────────

/** Слова, що самі задають день: тоді «о 9» у минулому - не помилка, а завтра/дата. */
const DAY_MARKER_RE =
  /завтра|післязавтра|(?:^|\s)через(?:\s|$)|\d{1,2}\.\d{1,2}\.\d{2,4}|\d{1,2}\s+(?:січ|лют|бер|кві|тра|чер|лип|сер|вер|жов|лис|гру)/i;
/** Голий час «14:00», «на 19», «о 19.30» - без слів про день. */
const BARE_CLOCK_RE = /^\s*(?:о|на)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*$/i;

/**
 * Час нагадування з тексту моделі: природний («о 14:00», «завтра о 12»),
 * голий («14:00») або ISO зі зсувом. Голе «о 9:00», коли вже 10:00, парсер
 * мовчки переносить на завтра - тут це S-1-15: підказка «завтра о HH:MM?»
 * у помилці, власник вирішує сам (модель повторює з «завтра»).
 * @param {unknown} raw @param {number} nowMs
 */
export function resolveAt(raw, nowMs) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('at обовʼязковий («о 14:00», «завтра о 12»)');
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  if (Number.isFinite(iso)) {
    if (iso <= nowMs) throw pastError(iso);
    return iso;
  }
  const bare = text.match(BARE_CLOCK_RE);
  if (bare) {
    const todayMs = clockOnDay(Number(bare[1]), Number(bare[2] ?? 0), kyivDateKey(new Date(nowMs)));
    if (todayMs == null) throw new Error(`не розібрав час «${text}»`);
    if (todayMs <= nowMs) throw pastError(todayMs);
    return todayMs;
  }
  const ms = parseReminderTime(text, nowMs)?.whenMs;
  if (ms == null || !Number.isFinite(ms)) {
    throw new Error(`не розібрав час «${text}» - попроси власника сказати інакше («о 14:00»)`);
  }
  // Парсер уже перекотив на завтра? Той самий годинник сьогодні в минулому і
  // різниця ≈ доба (DST ±1 год) - без слова про день це S-1-15.
  const todayMs = kyivMs(kyivDateKey(new Date(nowMs)), kyivClock(ms));
  const rolled =
    !DAY_MARKER_RE.test(text) &&
    todayMs != null &&
    todayMs <= nowMs &&
    Math.abs(ms - todayMs - 86_400_000) <= 3_600_000;
  if (ms <= nowMs || rolled) throw pastError(ms);
  return ms;
}

/** @param {number} ms */
function pastError(ms) {
  const clock = kyivClock(ms);
  return new Error(
    `${clock} уже минуло - спитай власника: «завтра о ${clock}?» і повтори з «завтра о ${clock}»`,
  );
}

/** Київський момент HH:MM у день dateKey (null - кривий годинник). @param {number} h @param {number} m @param {string} dateKey */
function clockOnDay(h, m, dateKey) {
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null;
  return kyivMs(dateKey, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

/**
 * Час броні відносно ДНЯ нагадування (S-1-8 «На котру?»): «19:00» / «о 19» /
 * «на 19.30» → того ж київського дня, що й at; раніше за at (бронь до
 * нагадування) - наступного дня. ISO зі зсувом - як є.
 * @param {string} text @param {number} atMs
 */
export function resolveBookingAt(text, atMs) {
  const raw = String(text ?? '').trim();
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isFinite(iso)) return iso;
  const m = raw.match(/(\d{1,2})(?:[:.](\d{2}))?/);
  if (!m) return null;
  const day = kyivDateKey(new Date(atMs));
  let ms = clockOnDay(Number(m[1]), Number(m[2] ?? 0), day);
  if (ms == null) return null;
  if (ms < atMs) ms = clockOnDay(Number(m[1]), Number(m[2] ?? 0), addDaysToDateKey(day, 1));
  return ms;
}

/** @param {unknown} v */
function stringList(v) {
  return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}

/**
 * Кандидати: place_id від моделі (лише ті, що є в кеші `places` - інакше
 * модель вигадала id), інакше власний пошук за назвою (місто з payload або
 * геолокація власника ≤ 6 год). Порожньо - ланцюг без списку (S-1-4).
 * @param {Env} env @param {{ venue: string, city: string | null, candidates: string[] }} input @param {number} nowMs
 */
export async function resolveCandidates(env, input, nowMs) {
  const wanted = input.candidates.slice(0, PLACES_SEARCH_MAX);
  if (wanted.length) {
    const { results } = await db(env)
      .prepare(
        `SELECT place_id FROM places WHERE place_id IN (${wanted.map(() => '?').join(', ')})`,
      )
      .bind(...wanted)
      .all();
    const known = new Set((results ?? []).map((r) => String(r.place_id)));
    const ids = wanted.filter((id) => known.has(id));
    if (ids.length) return { ids, searched: false };
  }
  let near = null;
  if (!input.city) {
    const geo = /** @type {any} */ ((await runGeoLast(env, nowMs)).result);
    if (geo.known && (geo.ageMs == null || geo.ageMs <= GEO_FRESH_MS)) {
      near = { lat: geo.lat, lon: geo.lon };
    }
  }
  try {
    const { places } = await placesSearch(
      env,
      { query: input.venue, city: input.city, near },
      nowMs,
    );
    return { ids: places.map((p) => p.place_id), searched: true };
  } catch (e) {
    // Квота 100 % без кешу - ланцюг без списку (S-1-14: «поле назва/номер»),
    // збій API - теж без списку, але в лог.
    if (!(e instanceof QuotaExhaustedError)) {
      console.error(
        'table-chain: пошук закладів упав, ланцюг без списку',
        /** @type {any} */ (e)?.message,
      );
    }
    return { ids: [], searched: true, degraded: true };
  }
}

/**
 * Виконавець chain.start(kind=table): payload {venue, at, city?, candidates?
 * (place_id), participants?, booking_at?}. Повертає результат для моделі
 * (S-1-1: «Нагадаю о 14:00 і дам список закладів …») і знімок для «↩».
 * @param {Env} env
 * @param {Record<string, unknown>} payload
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 */
export async function startTableChain(env, payload, nowMs, ctx) {
  if (!env.TABLE_CHAIN) throw new Error('привʼязки TABLE_CHAIN (Workflow) немає');
  const venue = String(payload.venue ?? '')
    .trim()
    .slice(0, 120);
  if (!venue) throw new Error('venue обовʼязковий (назва закладу)');
  const atMs = resolveAt(payload.at, nowMs);
  let bookingMs = null;
  if (payload.booking_at) {
    bookingMs = resolveBookingAt(String(payload.booking_at), atMs);
    if (bookingMs == null) throw new Error(`не розібрав час броні «${String(payload.booking_at)}»`);
  }
  const city = payload.city ? String(payload.city).trim().slice(0, 60) : null;
  const found = await resolveCandidates(
    env,
    { venue, city, candidates: stringList(payload.candidates) },
    nowMs,
  );
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  const threadKey = ctx.threadId == null ? null : String(ctx.threadId);
  /** @type {TableState} */
  const state = {
    venue,
    at: new Date(atMs).toISOString(),
    booking_at: bookingMs == null ? null : new Date(bookingMs).toISOString(),
    city,
    candidates: found.ids,
    participants: stringList(payload.participants).slice(0, 10),
    chat_id: ctx.chatId ?? null,
    thread_id: threadKey,
    awaiting: null,
  };
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(chainId, CHAIN_KIND, chainId, JSON.stringify(state), iso, iso)
    .run();
  try {
    await env.TABLE_CHAIN.create({ id: chainId, params: { chainId } });
  } catch (/** @type {any} */ e) {
    await patchChainState(env, chainId, 'failed', { awaiting: null }, { nowMs });
    throw new Error(`Workflow столика не стартував: ${String(e?.message ?? e)}`, { cause: e });
  }
  const n = found.ids.length;
  const where = city ? `, ${city}` : '';
  const list =
    n > 0
      ? `дам список закладів (знайшов ${n}${where})`
      : found.degraded
        ? 'довідник закладів зараз недоступний - спитаю назву або номер'
        : `закладу «${venue}»${where} не знайшов - спитаю назву точніше або номер`;
  return {
    result: {
      chain_id: chainId,
      at: kyivClock(atMs),
      candidates: n,
      text: `Нагадаю о ${kyivClock(atMs)} і ${list}.`,
      note: 'ланцюг далі веде ядро кнопками; власнику скажи лише перший рядок',
    },
    prev: { chain_id: chainId },
  };
}

/**
 * Скасування (S-1-12, «↩» після старту, chain.cancel): статус cancelled +
 * подія cancel, щоб Workflow прокинувся одразу; не доставилась - машина
 * станів побачить cancelled на наступному записі стану. false - ланцюг уже
 * не активний.
 * @param {Env} env @param {string} chainId
 */
export async function cancelTableChain(env, chainId) {
  const { meta } = await db(env)
    .prepare(
      `UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ? AND kind = ? AND status IN ('running', 'waiting')`,
    )
    .bind(new Date().toISOString(), chainId, CHAIN_KIND)
    .run();
  if (!meta?.changes) return false;
  try {
    await sendChainEvent(env, chainId, 'table', { action: 'cancel' });
  } catch (/** @type {any} */ e) {
    console.error(
      `table-chain ${chainId}: подія cancel не доставлена (закриє наступний запис стану)`,
      e?.message,
    );
  }
  return true;
}

/**
 * Активний ланцюг столика: за id або найсвіжіший (для «скасуй столик»).
 * @param {Env} env @param {string | null} chainId
 */
export async function findActiveTableChain(env, chainId) {
  const row = /** @type {{ id: string, state_json: string } | null} */ (
    chainId
      ? await db(env)
          .prepare(
            `SELECT id, state_json FROM chains WHERE id = ? AND kind = ? AND status IN ('running', 'waiting')`,
          )
          .bind(chainId, CHAIN_KIND)
          .first()
      : await db(env)
          .prepare(
            `SELECT id, state_json FROM chains WHERE kind = ? AND status IN ('running', 'waiting') ORDER BY created_at DESC LIMIT 1`,
          )
          .bind(CHAIN_KIND)
          .first()
  );
  if (!row) return null;
  return { id: String(row.id), venue: venueOf(row.state_json) };
}

/** Назва з state_json (битий JSON - порожньо). @param {string | null} stateJson */
function venueOf(stateJson) {
  try {
    return String(JSON.parse(stateJson ?? '{}')?.venue ?? '');
  } catch {
    return '';
  }
}

/** @param {Env} env @param {string} chainId @returns {Promise<TableState>} */
export async function loadTableState(env, chainId) {
  const row = await readChainState(env, chainId);
  if (!row) throw new Error(`ланцюга ${chainId} немає`);
  return /** @type {TableState} */ (row.state);
}

// ── Машина станів Workflow ─────────────────────────────────────────────────

/**
 * @param {Env} env
 * @param {TableParams & { state?: TableState }} params
 * @param {ChainStep} step
 * @param {TableIo} io
 */
export async function runTableChain(env, params, step, io) {
  const { chainId } = params;
  const state = params.state ?? (await step.do('state', () => loadTableState(env, chainId)));
  let lastAwaiting = /** @type {string | null} */ (null);

  /**
   * Запис стану, що шанує cancelled: chain.cancel міг поставити статус без
   * доставленої події - тоді рядок не змінюється, і машина станів зупиняється.
   * @param {'running' | 'waiting'} status @param {Record<string, unknown>} patch
   */
  const write = async (status, patch) => {
    const ok = await patchChainState(env, chainId, status, patch, {
      unlessCancelled: true,
      nowMs: io.now(),
    });
    if (!ok) throw new Cancelled();
  };
  /**
   * Перейти в стан очікування і дочекатись події (cancel - виняток нагору,
   * тиша - null). awaiting_since не оновлюється, поки стан той самий (S-1-6:
   * «понад добу» рахується від першого питання).
   * @param {string} label @param {string} awaiting @param {number} ms @param {Record<string, unknown>} [patch]
   * @returns {Promise<Record<string, any> | null>}
   */
  const waitFor = async (label, awaiting, ms, patch = {}) => {
    const since =
      awaiting === lastAwaiting ? {} : { awaiting_since: new Date(io.now()).toISOString() };
    lastAwaiting = awaiting;
    await step.do(`${label}-await`, () => write('waiting', { awaiting, ...since, ...patch }));
    const ev = await waitOrNull(step, `${label}-wait`, 'table', ms);
    if (ev?.action === 'cancel') throw new Cancelled();
    return ev;
  };
  const run = (/** @type {string} */ label, /** @type {Record<string, unknown>} */ patch = {}) =>
    step.do(`${label}-run`, () => write('running', { awaiting: null, nudge: null, ...patch }));
  const abandon = (/** @type {string} */ label) =>
    step.do(`${label}-abandon`, () =>
      patchChainState(env, chainId, 'done', { awaiting: null, nudge: null }, { nowMs: io.now() }),
    );
  const nudgeFrom = () => ({
    nudge: { at: new Date(io.now() + NUDGE_FIRST_MS).toISOString(), n: 0 },
  });

  try {
    // 1. Спати до часу нагадування; cancel може прийти й тут, інші події
    // (кнопок ще немає) - ігноруються, сон триває.
    const atMs = Date.parse(state.at);
    for (let i = 0; i < SLEEP_ROUNDS_MAX && atMs > io.now(); i += 1) {
      const early = await waitOrNull(step, `until-at-${i}`, 'table', atMs - io.now());
      if (early?.action === 'cancel') throw new Cancelled();
    }

    // 2. Список закладів (S-1-5) - з кешу без API - або поле «назва/номер» (S-1-4).
    /** @type {PlaceCandidate[]} */
    let candidates = await step.do('candidates', async () => {
      const list = [];
      for (const id of state.candidates) {
        const p = await io.cached(id);
        if (p) list.push(p);
      }
      return list;
    });
    if (candidates.length) {
      await step.do('venue-buttons', () =>
        io.send(`Столик у ${state.venue}: який заклад?`, venueKeyboard(chainId, candidates)),
      );
    } else {
      await step.do('venue-ask', () =>
        io.send(
          `Нагадую: столик у ${state.venue}. Напиши назву закладу точніше або номер телефону.`,
        ),
      );
    }
    // Вибір - до 24 год з нагадуваннями +5/+20 (chain-nudge), далі тиша до тижня.
    const venueState = candidates.length ? 'venue' : 'venue_text';
    let ev = await waitFor('venue', venueState, WAIT_VENUE_MS, nudgeFrom());
    if (!ev) ev = await waitFor('venue-quiet', venueState, QUIET_MAX_MS, { nudge: null });
    if (!ev) {
      await abandon('venue');
      return { outcome: 'abandoned' };
    }

    // Кнопка v<i> / «Інший» / текст (назва або номер) - до 4 раундів.
    /** @type {PlaceCandidate | null} */
    let chosen = null;
    /** @type {{ name: string, phone: string | null } | null} */
    let manual = null;
    for (let r = 0; r < VENUE_ROUNDS_MAX && !chosen && !manual; r += 1) {
      const pick =
        ev?.action === 'venue' && Number.isInteger(ev.index) ? candidates[ev.index] : null;
      if (pick) {
        chosen = pick;
        break;
      }
      const text = ev?.action === 'text' ? String(ev.text ?? '').trim() : '';
      if (text) {
        const phone = phoneOf(text);
        if (phone) {
          manual = { name: state.venue, phone };
          break;
        }
        const found = await step.do(`venue-${r}-search`, () =>
          io.search(text).catch((/** @type {any} */ e) => {
            console.error(`table-chain ${chainId}: пошук «${text}» упав`, e?.message);
            return [];
          }),
        );
        if (found.length === 1) {
          chosen = found[0] ?? null;
          break;
        }
        if (found.length > 1) {
          candidates = found.slice(0, PLACES_SEARCH_MAX);
          await step.do(`venue-${r}-again`, () =>
            io.send('Знайшов кілька:', venueKeyboard(chainId, candidates)),
          );
          ev = await waitFor(`venue-${r}`, 'venue', WAIT_STEP_MS);
          continue;
        }
        // Нічого не знайшов - беремо як назву без довідника.
        manual = { name: text.slice(0, 120), phone: null };
        break;
      }
      await step.do(`venue-${r}-ask-name`, () =>
        io.send('Напиши назву закладу або номер телефону.'),
      );
      ev = await waitFor(`venue-${r}`, 'venue_text', WAIT_STEP_MS);
      if (!ev) {
        await abandon(`venue-${r}`);
        return { outcome: 'abandoned' };
      }
    }
    if (!chosen && !manual) {
      // Чотири раунди без вибору - чесно закриваємо, а не вдаємо заклад.
      await step.do('venue-giveup', () =>
        io.send(`Заклад так і не обрано - закриваю ланцюг «столик у ${state.venue}».`),
      );
      await abandon('venue-giveup');
      return { outcome: 'abandoned' };
    }
    // Деталі (SKU Enterprise) - ОДИН раз, для обраного (S-1-7, контракт adapters/maps).
    /** @type {PlaceDetails | null} */
    const place = chosen
      ? await step.do('details', () =>
          io
            .details(/** @type {PlaceCandidate} */ (chosen).place_id)
            .catch((/** @type {any} */ e) => {
              console.error(`table-chain ${chainId}: деталі закладу впали`, e?.message);
              return null;
            }),
        )
      : null;
    // Деталі впали - лишаємось із тим, що знали з пошуку.
    const known = place ?? chosen ?? null;
    await run('chosen', { place_id: known?.place_id ?? null, manual });

    // 3. Контакт (S-1-7): телефон + години, або «телефону немає» + ввести номер.
    const title = known?.name ?? manual?.name ?? state.venue;
    let phone = place?.phone ?? manual?.phone ?? null;
    const siteBtn = place?.site ? [{ text: '🌐 Сайт', url: place.site }] : null;
    let called = false;
    for (let t = 0; t < CONTACT_ROUNDS_MAX && !called; t += 1) {
      if (phone) {
        await step.do(`contact-${t}-send`, () =>
          io.sendContact(/** @type {string} */ (phone), title, [
            row(chainId, [
              ['📞 Подзвонив', 'called'],
              ['⏰ Пізніше', 'later'],
            ]),
            ...(siteBtn ? [siteBtn] : []),
          ]),
        );
        if (t === 0 && place?.hours.length) {
          await step.do('contact-hours', () => io.send(`Години: ${place.hours.join('; ')}`));
        }
      } else {
        await step.do(`contact-${t}-nophone`, () =>
          io.send(`${title}: телефону в довіднику немає.`, [
            ...(siteBtn ? [siteBtn] : []),
            row(chainId, [
              ['Ввести номер', 'phone'],
              ['📞 Подзвонив', 'called'],
            ]),
          ]),
        );
      }
      // Чужі/застарілі кнопки ігноруються - чекаємо далі в тому ж стані.
      let action = null;
      for (let w = 0; w < CONTACT_ROUNDS_MAX && action == null; w += 1) {
        ev = await waitFor(
          `contact-${t}-${w}`,
          'contact',
          WAIT_VENUE_MS,
          w === 0 ? nudgeFrom() : {},
        );
        if (!ev) {
          await abandon(`contact-${t}`);
          return { outcome: 'abandoned' };
        }
        if (
          ev.action === 'called' ||
          ev.action === 'later' ||
          ev.action === 'phone' ||
          ev.action === 'text'
        ) {
          action = String(ev.action);
        }
      }
      if (action === 'called') {
        called = true;
        break;
      }
      if (action === 'later') {
        await run(`contact-${t}-later`);
        await step.sleepUntil(`contact-${t}-later-sleep`, io.now() + LATER_MS);
        continue;
      }
      if (action === 'phone') {
        await step.do(`contact-${t}-ask-phone`, () => io.send('Напиши номер телефону закладу.'));
        ev = await waitFor(`contact-${t}-phone`, 'phone', WAIT_STEP_MS);
      }
      const typed = ev?.action === 'text' ? phoneOf(String(ev.text ?? '')) : null;
      if (typed) phone = typed;
      else
        await step.do(`contact-${t}-bad-phone`, () =>
          io.send('Номер не розпізнав - напиши цифрами.'),
        );
    }
    if (!called) {
      await abandon('contact');
      return { outcome: 'abandoned' };
    }
    await run('called');

    // 4. Час броні (S-1-8: «На котру?») - відносно дня нагадування.
    const booking = await step.do('booking', async () => {
      const preset = state.booking_at ? Date.parse(state.booking_at) : NaN;
      return Number.isFinite(preset) ? preset : null;
    });
    let bookingMs = booking;
    if (bookingMs == null) {
      await step.do('ask-time', () => io.send('На котру годину бронь?'));
      const t = await waitFor('time', 'time', WAIT_STEP_MS);
      bookingMs = await step.do('booking-parse', async () =>
        t?.action === 'text' ? resolveBookingAt(String(t.text ?? ''), atMs) : null,
      );
    }
    const bookingKnown = bookingMs != null;
    const endMs = Math.max(
      bookingKnown
        ? /** @type {number} */ (bookingMs) + BOOKING_SPAN_MS
        : atMs + UNKNOWN_BOOKING_SPAN_MS,
      atMs + 3_600_000,
    );
    await run('booking', {
      booking_at: bookingKnown ? new Date(/** @type {number} */ (bookingMs)).toISOString() : null,
    });

    const whenLabel = bookingKnown ? ` о ${kyivClock(/** @type {number} */ (bookingMs))}` : '';
    const actions = [
      row(chainId, [
        ['🗺 Маршрут', 'route'],
        ['🕒 Запланувати вихід', 'leave'],
      ]),
      row(chainId, [
        ['👥 Запросити', 'invite'],
        ['⭐ В улюблені', 'fav'],
        ['Готово', 'done'],
      ]),
    ];
    if (known && known.lat != null && known.lon != null) {
      await step.do('venue-card', () =>
        io.sendVenue(
          /** @type {number} */ (known.lat),
          /** @type {number} */ (known.lon),
          `${title}${whenLabel}`,
          known.address ?? title,
          actions,
        ),
      );
    } else {
      await step.do('venue-text', () => io.send(`${title}${whenLabel} - записав.`, actions));
    }

    // 5. Дії до кінця вечора (кожна повертає до кнопок). Індекс - за подією,
    // не за часом: імена кроків ті самі на кожному відтворенні.
    let mode = state.mode ?? null;
    for (let k = 0; k < ACTIONS_MAX && io.now() < endMs; k += 1) {
      const a = `act-${k}`;
      ev = await waitFor(a, 'next', Math.min(WAIT_VENUE_MS, Math.max(60_000, endMs - io.now())));
      if (!ev) break;
      // Текст «на 19:00» у стані next (registry пропускає лише годинник):
      // уточнення часу броні без кнопки.
      if (ev.action === 'text') {
        const fixed = await step.do(`${a}-time`, async () =>
          resolveBookingAt(String(ev?.text ?? ''), atMs),
        );
        if (fixed != null) {
          bookingMs = fixed;
          await run(`${a}-time`, { booking_at: new Date(fixed).toISOString() });
          await step.do(`${a}-time-ok`, () => io.send(`Бронь о ${kyivClock(fixed)} - записав.`));
        }
        continue;
      }
      const choice = ev.action === 'next' ? String(ev.choice) : null;
      if (choice === 'done') break;
      if (choice === 'fav' && known) {
        await step.do(`${a}-fav-db`, () =>
          db(env)
            .prepare('UPDATE places SET is_favorite = 1 WHERE place_id = ?')
            .bind(known.place_id)
            .run(),
        );
        await step.do(`${a}-fav-text`, () => io.send(`${title} - в улюблених ⭐`));
        continue;
      }
      if (choice === 'route' || choice === 'leave') {
        const to = known
          ? known.lat != null && known.lon != null
            ? { lat: known.lat, lon: known.lon }
            : { place_id: known.place_id }
          : { address: manual?.name ?? state.venue };
        if (choice === 'route' && known?.maps_uri) {
          await step.do(`${a}-maps`, () => io.send(`Карта: ${known.maps_uri}`));
        }
        let picked =
          choice === 'leave'
            ? (mode ?? (await step.do(`${a}-default-mode`, () => io.defaultMode())))
            : null;
        if (!picked) {
          await step.do(`${a}-ask-mode`, () =>
            io.send('Як добираєшся?', [
              row(chainId, [
                ['🚶 Пішки', 'mwalk'],
                ['🚌 Транспорт', 'mtransit'],
                ['🚗 Авто', 'mcar'],
              ]),
            ]),
          );
          const m = await waitFor(`${a}-mode`, 'mode', WAIT_STEP_MS);
          picked = m?.action === 'mode' ? String(m.mode) : null;
          if (!picked) continue;
        }
        mode = picked;
        const modeKey = /** @type {'walk' | 'transit' | 'car'} */ (mode);
        await run(`${a}-mode`, { mode });
        const eta = await step.do(`${a}-eta`, () =>
          io
            .eta(to, modeKey, choice === 'leave' ? 'home' : 'here', bookingKnown ? bookingMs : null)
            .catch((/** @type {any} */ e) => {
              console.error(`table-chain ${chainId}: routes.eta впав`, e?.message);
              return { error: String(e?.message ?? 'збій') };
            }),
        );
        if (!eta || 'error' in eta) {
          await step.do(`${a}-no-eta`, () =>
            io.send(
              `Маршрут порахувати не вдалось (${eta && 'error' in eta ? eta.error : 'немає даних'}).`,
            ),
          );
          continue;
        }
        if (choice === 'route') {
          await step.do(`${a}-eta-text`, () =>
            io.send(`${eta.duration_min} хв ${modeWord(modeKey)}.`),
          );
          continue;
        }
        if (!bookingKnown || bookingMs == null) {
          await step.do(`${a}-no-time`, () =>
            io.send('Не знаю часу броні - напиши «на 19:00», і порахую вихід.'),
          );
          continue;
        }
        const leaveMs = bookingMs - (eta.duration_min + LEAVE_BUFFER_MIN) * 60_000;
        const proposal = await step.do(`${a}-propose-leave`, () =>
          io.propose('calendar.event', {
            title: `Вийти до «${title}»`,
            startIso: new Date(leaveMs).toISOString(),
            endIso: new Date(/** @type {number} */ (bookingMs)).toISOString(),
            reminderMinutes: 5,
            location: known?.address ?? null,
          }),
        );
        await step.do(`${a}-leave-text`, () =>
          io.send(
            `Вийти о ${kyivClock(leaveMs)} (${modeWord(modeKey)} ${eta.duration_min} хв + ${LEAVE_BUFFER_MIN} хв)${proposal ? ' - у календар?' : ' (пропозицію в календар створити не вдалось)'}`,
            proposal ? /** @type {Keyboard} */ (proposal.buttons) : undefined,
          ),
        );
        continue;
      }
      if (choice === 'invite') {
        if (!bookingKnown || bookingMs == null) {
          await step.do(`${a}-invite-no-time`, () =>
            io.send('Не знаю часу броні - напиши «на 19:00», тоді запрошу.'),
          );
          continue;
        }
        let names = state.participants;
        if (!names.length) {
          await step.do(`${a}-ask-who`, () => io.send('Кого запросити? Імена через кому.'));
          const who = await waitFor(`${a}-who`, 'invitees', WAIT_STEP_MS);
          names =
            who?.action === 'text'
              ? String(who.text ?? '')
                  .split(/[,;]|\s+і\s+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [];
          if (!names.length) continue;
        }
        const found = await step.do(`${a}-attendees`, () => io.attendees(names));
        if (!found.emails.length) {
          await step.do(`${a}-no-emails`, () =>
            io.send(
              `Email не знайшов: ${found.notes.join('; ') || names.join(', ')}. Скажи «email Олі - …», і запишу контакт.`,
            ),
          );
          continue;
        }
        const proposal = await step.do(`${a}-propose-invite`, () =>
          io.propose('invite', {
            title,
            startIso: new Date(/** @type {number} */ (bookingMs)).toISOString(),
            endIso: new Date(/** @type {number} */ (bookingMs) + BOOKING_SPAN_MS).toISOString(),
            attendees: found.emails,
            location: known?.address ?? null,
          }),
        );
        await step.do(`${a}-invite-text`, () =>
          io.send(
            `Запросити ${names.join(', ')} (${found.emails.join(', ')}) на ${kyivClock(/** @type {number} */ (bookingMs))} у ${title} (Calendar-запрошення)?${found.notes.length ? `\n${found.notes.join('\n')}` : ''}`,
            proposal ? /** @type {Keyboard} */ (proposal.buttons) : undefined,
          ),
        );
        continue;
      }
    }

    // 6. «Як було?» через 2 год після кінця (S-1-11).
    await run('evening');
    await step.sleepUntil('after-end', endMs + AFTER_END_MS);
    await step.do('ask-rating', () =>
      io.send(`Як було у ${title}?`, [
        row(chainId, [
          ['⭐1', 'r1'],
          ['⭐2', 'r2'],
          ['⭐3', 'r3'],
          ['⭐4', 'r4'],
          ['⭐5', 'r5'],
        ]),
        row(chainId, [['Пропустити', 'rskip']]),
      ]),
    );
    const rated = await waitFor('rating', 'rating', WAIT_VENUE_MS);
    const stars =
      rated?.action === 'rating' && Number.isInteger(rated.stars) ? Number(rated.stars) : null;
    if (known) {
      // Один UPDATE - ідемпотентний відносно повтору кроку (visits +1 рівно раз).
      await step.do('finish-place', () =>
        db(env)
          .prepare(
            'UPDATE places SET rating_owner = COALESCE(?, rating_owner), visits = visits + 1 WHERE place_id = ?',
          )
          .bind(stars, known.place_id)
          .run(),
      );
    }
    await step.do('finish-state', () =>
      // json_patch: null стирає ключ, тож оцінка пишеться лише коли є.
      patchChainState(
        env,
        chainId,
        'done',
        { awaiting: null, nudge: null, ...(stars != null ? { rating: stars } : {}) },
        { nowMs: io.now() },
      ),
    );
    if (stars != null) {
      await step.do('finish-text', () => io.send(`Записав ${stars}/5 для ${title}.`));
    }
    return { outcome: 'done', place_id: known?.place_id ?? null };
  } catch (e) {
    if (e instanceof Cancelled) {
      await step.do('cancelled-state', () =>
        patchChainState(
          env,
          chainId,
          'cancelled',
          { awaiting: null, nudge: null },
          { nowMs: io.now() },
        ),
      );
      await step.do('cancelled-text', () => io.send(`Скасував ланцюг «столик у ${state.venue}».`));
      return { outcome: 'cancelled' };
    }
    throw e;
  }
}

// ── Помічники ──────────────────────────────────────────────────────────────

/** «вул. Вірменська 6, Львів» → « · вул. Вірменська 6». @param {string | null} address */
export function streetOf(address) {
  if (!address) return '';
  const first = address.split(',')[0]?.trim() ?? '';
  return first ? ` · ${first.slice(0, 40)}` : '';
}

/**
 * Телефон із тексту: групи по ≥ 2 цифри (пробіли/дужки/дефіси між ними),
 * разом ≥ 9 цифр, можливий +. «на 7 8 9 10» - не телефон.
 * @param {string} text
 */
export function phoneOf(text) {
  const m = text.match(/\+?\d{2,}(?:[\s()-]*\d{2,})*/);
  if (!m) return null;
  const digits = m[0].replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 9 ? digits : null;
}

// ── Бойове io ──────────────────────────────────────────────────────────────

/**
 * @param {Env} env @param {string} chainId @param {TableState} state
 * @returns {TableIo}
 */
export function productionIo(env, chainId, state) {
  const { chatId, threadId } = chainTarget(env, state);
  const post = (
    /** @type {'send' | 'contact' | 'venue'} */ kind,
    /** @type {Record<string, unknown>} */ payload,
    /** @type {unknown} */ btns,
    /** @type {import('../tg/markdown.mjs').MdPart[] | undefined} */ parts = undefined,
  ) =>
    postChainMessage(
      env,
      { chatId, threadId },
      { kind, payload, buttons: btns, parts, label: `table-chain ${chainId}` },
    );
  return {
    now: () => Date.now(),
    send: (text, btns) => post('send', {}, btns, renderMdParts(text)),
    sendContact: (phone, name, btns) =>
      post('contact', { phone_number: phone, first_name: name }, btns),
    sendVenue: (lat, lon, title, address, btns) =>
      post('venue', { latitude: lat, longitude: lon, title, address }, btns),
    search: async (query) =>
      (await placesSearch(env, { query, city: state.city, near: null }, Date.now())).places,
    cached: (placeId) => readPlace(env, placeId),
    details: async (placeId) => (await placeDetails(env, placeId, Date.now())).place,
    eta: async (to, mode, from, departAtMs) => {
      const nowMs = Date.now();
      const fromWp = await resolveWaypoint(env, from, nowMs);
      return routesEta(env, { from: fromWp, to, mode, departAtMs }, nowMs);
    },
    propose: async (kind, payload) => {
      const out = await applyPolicy(
        env,
        {
          kind,
          payload,
          threadId: state.thread_id ?? env.TOPIC_ASSISTANT ?? null,
          chatId,
          tainted: false,
        },
        Date.now(),
      );
      return out.mode === 'proposed'
        ? { id: out.proposal.id, buttons: out.proposal.buttons }
        : null;
    },
    attendees: async (names) => {
      // Спершу локальні контакти (facts.contact), далі Google Contacts (S-1-10).
      const emails = [];
      const rest = [];
      for (const raw of names) {
        const fact = /** @type {any} */ (
          (await runFactsGet(env, { kind: 'contact', key: raw.toLowerCase() })).result[0]
        );
        const email = typeof fact?.value?.email === 'string' ? fact.value.email : null;
        if (email) emails.push(email);
        else rest.push(raw);
      }
      const google = rest.length ? await resolveAttendees(env, rest) : { emails: [], notes: [] };
      return { emails: [...emails, ...google.emails], notes: google.notes };
    },
    defaultMode: async () => {
      const fact = /** @type {any} */ (
        (await runFactsGet(env, { kind: 'setting', key: 'default_mode' })).result[0]
      );
      const v = String(fact?.value?.mode ?? fact?.value ?? '');
      return v === 'walk' || v === 'transit' || v === 'car' ? v : null;
    },
  };
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class TableChain extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<TableParams>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {TableParams} */ (event.payload);
    try {
      // Стан - один мемоїзований крок: io і машина станів читають його раз.
      const state = await step.do('state', () => loadTableState(env, params.chainId));
      const io = productionIo(env, params.chainId, state);
      return await runTableChain(env, { ...params, state }, step, io);
    } catch (/** @type {any} */ e) {
      console.error(`table chain ${params.chainId} впав`, e?.message);
      await patchChainState(env, params.chainId, 'failed', { awaiting: null, nudge: null }).catch(
        (/** @type {any} */ e2) =>
          console.error(`table chain ${params.chainId}: статус failed не записано`, e2?.message),
      );
      throw e;
    }
  }
}
