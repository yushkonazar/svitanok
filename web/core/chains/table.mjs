// TableChain (07 §6, S-1-1…S-1-15, етап 5 PR-2): ланцюг «столик» - від
// «нагадай забронювати столик у Креденс о 14:00» до «Як було?». Старт з чату
// (chain.start kind=table через policy, T0 з «↩»): кандидати з кешу `places`
// (модель шукала places.search) або власний пошук, час нагадування рахує
// ядро (parseReminderTime), рядок у `chains` + інстанс Workflow (id = chainId).
//
// Машина станів runTableChain(env, params, step, io): усі кроки через
// step.do, очікування - ОДИН тип події `table` з payload.action (кнопки
// c:<id>:<choice> і текст власника перекладає chains/registry.mjs), вихід у
// світ - через io (повідомлення, контакт, точка на карті, довідник, маршрут,
// пропозиції). Скасування - дія `cancel` у будь-якому очікуванні. Тиша
// власника - штатний шлях: після 24 год ланцюг лишається waiting і мовчить
// (нагадування +5/+20 шле задача chain-nudge, мʼякий рядок - prerouter),
// через 7 днів без вибору - done без результату.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { parseReminderTime } from '../../reminders-core.mjs';
import { kyivClock, kyivDateKey } from '../../kyiv-time.mjs';
import { kyivMs } from '../day-plan/store.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { setChainState, readChainState, waitOrNull } from './state.mjs';
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
export const WAIT_STEP_MS = 3_600_000;
/** «Пізніше» - повторити контакт через пів години. */
export const LATER_MS = 30 * 60_000;
/** Локація з geo.last годиться для пошуку, поки їй ≤ 6 год (S-1-2). */
export const GEO_FRESH_MS = 6 * 3_600_000;
/** Бронь без відомого часу: «Як було?» через стільки після нагадування. */
export const UNKNOWN_BOOKING_SPAN_MS = 6 * 3_600_000;
/** Тривалість вечора для «Як було?» (07 §6: end + 2 год) і події запрошення. */
export const BOOKING_SPAN_MS = 2 * 3_600_000;
export const AFTER_END_MS = 2 * 3_600_000;
/** Запас до виходу поверх часу в дорозі (S-1-9: «+ 3 хв»). */
export const LEAVE_BUFFER_MIN = 3;
/** Нагадування «не натиснув кнопку» (S-1-6): +5 і ще раз через 15 (= +20). */
export const NUDGE_FIRST_MS = 5 * 60_000;
export const NUDGE_SECOND_MS = 15 * 60_000;
export const NUDGES_MAX = 2;

/**
 * @typedef {{
 *   now: () => number,
 *   send: (text: string, buttons?: { text: string, callback_data?: string, url?: string }[][]) => Promise<void>,
 *   sendContact: (phone: string, name: string, buttons?: { text: string, callback_data?: string, url?: string }[][]) => Promise<void>,
 *   sendVenue: (lat: number, lon: number, title: string, address: string, buttons?: { text: string, callback_data?: string, url?: string }[][]) => Promise<void>,
 *   search: (query: string) => Promise<import('../adapters/maps.mjs').PlaceCandidate[]>,
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
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - ланцюг недоступний');
  return env.DB;
}

/** Кнопки ланцюга (07 §9 `c:<id>:<choice>`). @param {string} chainId @param {[string, string][]} pairs */
export function buttons(chainId, pairs) {
  return pairs.map(([text, choice]) => ({ text, callback_data: `c:${chainId}:${choice}` }));
}

// ── Старт з чату (виконавець chain.start kind=table) ───────────────────────

/** Слова, що самі задають день: тоді «о 9» у минулому - не помилка, а завтра/дата. */
const DAY_MARKER_RE = /завтра|післязавтра|\bчерез\b|\d{1,2}\.\d{2}|\d{1,2}\s+[а-яіїє]{4,}/i;

/**
 * Час нагадування з тексту моделі: природний («о 14:00», «завтра о 12») або
 * ISO зі зсувом. Голе «о 9:00», коли вже 10:00, парсер мовчки переносить на
 * завтра - тут це S-1-15: підказка «завтра о HH:MM?» у помилці, власник
 * вирішує сам (модель повторює з «завтра»).
 * @param {unknown} raw @param {number} nowMs
 */
export function resolveAt(raw, nowMs) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('at обовʼязковий («о 14:00», «завтра о 12»)');
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  const ms = Number.isFinite(iso) ? iso : parseReminderTime(text, nowMs)?.whenMs;
  if (ms == null || !Number.isFinite(ms)) {
    throw new Error(`не розібрав час «${text}» - попроси власника сказати інакше («о 14:00»)`);
  }
  const clock = kyivClock(ms);
  const todayMs = kyivMs(kyivDateKey(new Date(nowMs)), clock);
  const rolled =
    !Number.isFinite(iso) &&
    !DAY_MARKER_RE.test(text) &&
    todayMs != null &&
    todayMs <= nowMs &&
    ms - todayMs >= 86_400_000 - 3_600_000;
  if (ms <= nowMs || rolled) {
    throw new Error(
      `${clock} уже минуло - спитай власника: «завтра о ${clock}?» і повтори з «завтра о ${clock}»`,
    );
  }
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
  const known = [];
  for (const id of input.candidates.slice(0, PLACES_SEARCH_MAX)) {
    if (await readPlace(env, id)) known.push(id);
  }
  if (known.length) return { ids: known, searched: false };
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
  const bookingMs = payload.booking_at ? resolveAt(payload.booking_at, nowMs) : null;
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
    await setChainState(env, chainId, { status: 'failed', awaiting: null });
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
 * подія cancel, щоб Workflow прокинувся одразу. false - ланцюг уже не активний.
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
    await sendTableEvent(env, chainId, { action: 'cancel' });
  } catch (/** @type {any} */ e) {
    console.error(
      `table-chain ${chainId}: подія cancel не доставлена (закриє таймаут)`,
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

/** @param {Env} env @param {string} chainId @param {Record<string, unknown>} payload */
export async function sendTableEvent(env, chainId, payload) {
  if (!env.TABLE_CHAIN) throw new Error('привʼязки TABLE_CHAIN (Workflow) немає');
  const instance = await env.TABLE_CHAIN.get(chainId);
  await instance.sendEvent({ type: 'table', payload });
  return true;
}

// ── Стан у D1 ──────────────────────────────────────────────────────────────

/**
 * Часткове оновлення state_json (json_patch: null у patch стирає ключ) +
 * статус. Один UPDATE, щоб паралельний chain-nudge не затер поле.
 * @param {Env} env @param {string} chainId
 * @param {'running' | 'waiting' | 'done' | 'failed' | 'cancelled'} status
 * @param {Record<string, unknown>} patch
 */
export async function patchTableState(env, chainId, status, patch) {
  await db(env)
    .prepare(
      `UPDATE chains SET status = ?, state_json = json_patch(COALESCE(state_json, '{}'), ?), updated_at = ? WHERE id = ?`,
    )
    .bind(status, JSON.stringify(patch), new Date().toISOString(), chainId)
    .run();
}

/** @param {Env} env @param {string} chainId @returns {Promise<TableState>} */
async function loadState(env, chainId) {
  const row = await readChainState(env, chainId);
  if (!row) throw new Error(`ланцюга ${chainId} немає`);
  return /** @type {TableState} */ (row.state);
}

// ── Машина станів Workflow ─────────────────────────────────────────────────

class Cancelled extends Error {}

/**
 * @param {Env} env
 * @param {TableParams} params
 * @param {ChainStep} step
 * @param {TableIo} io
 */
export async function runTableChain(env, params, step, io) {
  const { chainId } = params;
  const state = await step.do('state', () => loadState(env, chainId));
  let n = 0;
  const name = (/** @type {string} */ s) => `${s}-${(n += 1)}`;

  /**
   * Перейти в стан очікування і дочекатись події (cancel - виняток нагору).
   * Тиша - null. Патч стану - разом зі статусом waiting.
   * @param {string} awaiting @param {number} ms @param {Record<string, unknown>} [patch]
   * @returns {Promise<Record<string, any> | null>}
   */
  const waitFor = async (awaiting, ms, patch = {}) => {
    await step.do(name('await'), () =>
      patchTableState(env, chainId, 'waiting', {
        awaiting,
        awaiting_since: new Date(io.now()).toISOString(),
        ...patch,
      }),
    );
    const ev = await waitOrNull(step, name('wait'), 'table', ms);
    if (ev?.action === 'cancel') throw new Cancelled();
    // Скасовано ззовні (chain.cancel без доставки події) - теж кінець.
    if (
      ev == null &&
      (await step.do(name('check'), () => readChainState(env, chainId)))?.status === 'cancelled'
    ) {
      throw new Cancelled();
    }
    return ev;
  };
  const run = (/** @type {Record<string, unknown>} */ patch = {}) =>
    step.do(name('run'), () =>
      patchTableState(env, chainId, 'running', { awaiting: null, nudge: null, ...patch }),
    );

  try {
    // 1. Спати до часу нагадування; cancel може прийти й тут, інші події
    // (кнопок ще немає) - ігноруються, сон триває.
    const atMs = Date.parse(state.at);
    while (atMs > io.now()) {
      const early = await waitOrNull(step, name('until-at'), 'table', atMs - io.now());
      if (early?.action === 'cancel') throw new Cancelled();
    }

    // 2. Список закладів (S-1-5) або поле «назва/номер» (S-1-4).
    const candidates = await step.do('candidates', async () => {
      const list = [];
      for (const id of state.candidates) {
        const p = await io.details(id).catch(() => null);
        if (p) list.push(p);
      }
      return list;
    });
    /** @type {import('../adapters/maps.mjs').PlaceDetails | null} */
    let place = null;
    /** @type {{ name: string, phone: string | null } | null} */
    let manual = null;
    if (candidates.length) {
      await step.do('venue-buttons', () =>
        io.send(`Столик у ${state.venue}: який заклад?`, [
          ...candidates.map((p, i) =>
            buttons(chainId, [[`${p.name}${streetOf(p.address)}`, `v${i}`]]),
          ),
          buttons(chainId, [['Інший', 'vother']]),
        ]),
      );
    } else {
      await step.do('venue-ask', () =>
        io.send(
          `Нагадую: столик у ${state.venue}. Напиши назву закладу точніше або номер телефону.`,
        ),
      );
    }
    // Вибір - до 24 год з нагадуваннями +5/+20 (chain-nudge), далі тиша до тижня.
    let ev = await waitFor(candidates.length ? 'venue' : 'venue_text', WAIT_VENUE_MS, {
      nudge: { at: new Date(io.now() + NUDGE_FIRST_MS).toISOString(), n: 0 },
    });
    if (!ev) {
      ev = await waitFor(candidates.length ? 'venue' : 'venue_text', QUIET_MAX_MS, { nudge: null });
      if (!ev) {
        await run({ awaiting: null });
        await step.do('abandon', () =>
          setChainState(env, chainId, { status: 'done', awaiting: null }),
        );
        return { outcome: 'abandoned' };
      }
    }
    // Кнопка v<i> / «Інший» / текст.
    for (let guard = 0; guard < 4 && !place && !manual; guard += 1) {
      if (ev?.action === 'venue' && Number.isInteger(ev.index) && candidates[ev.index]) {
        place = candidates[ev.index] ?? null;
        break;
      }
      const text = ev?.action === 'text' ? String(ev.text ?? '').trim() : '';
      if (text) {
        const phone = phoneOf(text);
        if (phone) {
          manual = { name: state.venue, phone };
          break;
        }
        const found = await step.do(name('search'), () => io.search(text).catch(() => []));
        if (found.length === 1 || (found.length > 1 && guard >= 1)) {
          place = await step.do(name('details'), () =>
            io.details(found[0]?.place_id ?? '').catch(() => null),
          );
          if (place) break;
        }
        if (found.length > 1) {
          await step.do(name('again'), () =>
            io.send(`Знайшов кілька:`, [
              ...found
                .slice(0, PLACES_SEARCH_MAX)
                .map((p, i) => buttons(chainId, [[`${p.name}${streetOf(p.address)}`, `v${i}`]])),
              buttons(chainId, [['Інший', 'vother']]),
            ]),
          );
          candidates.splice(0, candidates.length);
          for (const p of found.slice(0, PLACES_SEARCH_MAX)) {
            const d = await step.do(name('cand'), () => io.details(p.place_id).catch(() => null));
            if (d) candidates.push(d);
          }
          ev = await waitFor('venue', WAIT_STEP_MS);
          continue;
        }
        // Нічого не знайшов - беремо як назву без довідника.
        manual = { name: text.slice(0, 120), phone: null };
        break;
      }
      await step.do(name('ask-name'), () => io.send('Напиши назву закладу або номер телефону.'));
      ev = await waitFor('venue_text', WAIT_STEP_MS);
      if (!ev) {
        await step.do('abandon-name', () =>
          setChainState(env, chainId, { status: 'done', awaiting: null }),
        );
        return { outcome: 'abandoned' };
      }
    }
    if (!place && !manual) manual = { name: state.venue, phone: null };
    await run({ place_id: place?.place_id ?? null, manual });

    // 3. Контакт (S-1-7): телефон + години, або «телефону немає» + ввести номер.
    const title = place?.name ?? manual?.name ?? state.venue;
    let phone = place?.phone ?? manual?.phone ?? null;
    const siteBtn = place?.site ? [{ text: '🌐 Сайт', url: place.site }] : null;
    for (let tries = 0; tries < 3; tries += 1) {
      if (phone) {
        await step.do(name('contact'), () =>
          io.sendContact(/** @type {string} */ (phone), title, [
            buttons(chainId, [
              ['📞 Подзвонив', 'called'],
              ['⏰ Пізніше', 'later'],
            ]),
            ...(siteBtn ? [siteBtn] : []),
          ]),
        );
        if (place?.hours.length) {
          await step.do(name('hours'), () => io.send(`Години: ${place.hours.join('; ')}`));
        }
      } else {
        await step.do(name('no-phone'), () =>
          io.send(`${title}: телефону в довіднику немає.`, [
            ...(siteBtn ? [siteBtn] : []),
            buttons(chainId, [
              ['Ввести номер', 'phone'],
              ['📞 Подзвонив', 'called'],
            ]),
          ]),
        );
      }
      ev = await waitFor('contact', WAIT_VENUE_MS, {
        nudge: { at: new Date(io.now() + NUDGE_FIRST_MS).toISOString(), n: 0 },
      });
      if (!ev) {
        await step.do('abandon-contact', () =>
          setChainState(env, chainId, { status: 'done', awaiting: null }),
        );
        return { outcome: 'abandoned' };
      }
      if (ev.action === 'called') break;
      if (ev.action === 'later') {
        await run();
        await step.sleepUntil(name('later'), io.now() + LATER_MS);
        continue;
      }
      if (ev.action === 'phone' || ev.action === 'text') {
        if (ev.action === 'phone') {
          await step.do(name('ask-phone'), () => io.send('Напиши номер телефону закладу.'));
          ev = await waitFor('phone', WAIT_STEP_MS);
        }
        const typed = ev?.action === 'text' ? phoneOf(String(ev.text ?? '')) : null;
        if (typed) {
          phone = typed;
          continue;
        }
        await step.do(name('bad-phone'), () => io.send('Номер не розпізнав - напиши цифрами.'));
      }
    }
    await run();

    // 4. Час броні (S-1-8: «На котру?»), точка на карті й дії.
    let bookingMs = state.booking_at ? Date.parse(state.booking_at) : NaN;
    if (!Number.isFinite(bookingMs)) {
      await step.do(name('ask-time'), () => io.send('На котру годину бронь?'));
      const t = await waitFor('time', WAIT_STEP_MS);
      const parsed = t?.action === 'text' ? parseClock(String(t.text ?? ''), atMs, io.now()) : null;
      if (parsed != null) bookingMs = parsed;
    }
    const bookingKnown = Number.isFinite(bookingMs);
    const endMs = bookingKnown ? bookingMs + BOOKING_SPAN_MS : atMs + UNKNOWN_BOOKING_SPAN_MS;
    await run({ booking_at: bookingKnown ? new Date(bookingMs).toISOString() : null });

    const actions = [
      buttons(chainId, [
        ['🗺 Маршрут', 'route'],
        ['🕒 Запланувати вихід', 'leave'],
      ]),
      buttons(chainId, [
        ['👥 Запросити', 'invite'],
        ['⭐ В улюблені', 'fav'],
        ['Готово', 'done'],
      ]),
    ];
    if (place && place.lat != null && place.lon != null) {
      await step.do('venue-card', () =>
        io.sendVenue(
          /** @type {number} */ (place.lat),
          /** @type {number} */ (place.lon),
          `${title}${bookingKnown ? ` о ${kyivClock(bookingMs)}` : ''}`,
          place.address ?? '',
          actions,
        ),
      );
    } else {
      await step.do('venue-text', () =>
        io.send(`${title}${bookingKnown ? ` о ${kyivClock(bookingMs)}` : ''} - записав.`, actions),
      );
    }

    // 5. Дії до кінця вечора (кожна повертає до кнопок).
    let mode = state.mode ?? null;
    while (io.now() < endMs) {
      ev = await waitFor('next', Math.min(WAIT_VENUE_MS, Math.max(60_000, endMs - io.now())));
      if (!ev) break;
      const choice = ev.action === 'next' ? String(ev.choice) : null;
      if (choice === 'done') break;
      if (choice === 'fav' && place) {
        await step.do(name('fav'), async () => {
          await db(env)
            .prepare('UPDATE places SET is_favorite = 1 WHERE place_id = ?')
            .bind(place.place_id)
            .run();
          await io.send(`${title} - в улюблених ⭐`);
        });
        continue;
      }
      if (choice === 'route' || choice === 'leave') {
        const to = place
          ? place.lat != null && place.lon != null
            ? { lat: place.lat, lon: place.lon }
            : { place_id: place.place_id }
          : { address: manual?.name ?? state.venue };
        if (choice === 'route' && place?.maps_uri) {
          await step.do(name('maps'), () => io.send(`Карта: ${place.maps_uri}`));
        }
        let picked =
          choice === 'leave'
            ? (mode ?? (await step.do(name('default-mode'), () => io.defaultMode())))
            : null;
        if (!picked) {
          await step.do(name('ask-mode'), () =>
            io.send('Як добираєшся?', [
              buttons(chainId, [
                ['🚶 Пішки', 'mwalk'],
                ['🚌 Транспорт', 'mtransit'],
                ['🚗 Авто', 'mcar'],
              ]),
            ]),
          );
          const m = await waitFor('mode', WAIT_STEP_MS);
          picked = m?.action === 'mode' ? String(m.mode) : null;
          if (!picked) continue;
        }
        mode = picked;
        await run({ mode });
        const modeKey = /** @type {'walk' | 'transit' | 'car'} */ (mode);
        const eta = await step.do(name('eta'), () =>
          io
            .eta(to, modeKey, choice === 'leave' ? 'home' : 'here', bookingKnown ? bookingMs : null)
            .catch((e) => {
              console.error(`table-chain ${chainId}: routes.eta впав`, e?.message);
              return null;
            }),
        );
        if (!eta) {
          await step.do(name('no-eta'), () =>
            io.send('Маршрут порахувати не вдалось - подивись на карті.'),
          );
          continue;
        }
        if (choice === 'route') {
          await step.do(name('eta-text'), () =>
            io.send(`${eta.duration_min} хв ${modeWord(modeKey)}.`),
          );
          continue;
        }
        if (!bookingKnown) {
          await step.do(name('no-time'), () =>
            io.send('Не знаю часу броні - напиши «на 19:00», і порахую вихід.'),
          );
          continue;
        }
        const leaveMs = bookingMs - (eta.duration_min + LEAVE_BUFFER_MIN) * 60_000;
        const proposal = await step.do(name('propose-leave'), () =>
          io.propose('calendar.event', {
            title: `Вийти до «${title}»`,
            startIso: new Date(leaveMs).toISOString(),
            endIso: new Date(bookingMs).toISOString(),
            reminderMinutes: 5,
            location: place?.address ?? null,
          }),
        );
        await step.do(name('leave-text'), () =>
          io.send(
            `Вийти о ${kyivClock(leaveMs)} (${modeWord(modeKey)} ${eta.duration_min} хв + ${LEAVE_BUFFER_MIN} хв)${proposal ? ' - у календар?' : ' (пропозицію в календар створити не вдалось)'}`,
            proposal ? /** @type {any} */ (proposal.buttons) : undefined,
          ),
        );
        continue;
      }
      if (choice === 'invite') {
        let names = state.participants;
        if (!names.length) {
          await step.do(name('ask-who'), () => io.send('Кого запросити? Імена через кому.'));
          const who = await waitFor('invitees', WAIT_STEP_MS);
          names =
            who?.action === 'text'
              ? String(who.text ?? '')
                  .split(/[,;]|\s+і\s+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [];
          if (!names.length) continue;
        }
        if (!bookingKnown) {
          await step.do(name('invite-no-time'), () =>
            io.send('Не знаю часу броні - напиши «на 19:00», тоді запрошу.'),
          );
          continue;
        }
        const found = await step.do(name('attendees'), () => io.attendees(names));
        if (!found.emails.length) {
          await step.do(name('no-emails'), () =>
            io.send(
              `Email не знайшов: ${found.notes.join('; ') || names.join(', ')}. Скажи «email Олі - …», і запишу контакт.`,
            ),
          );
          continue;
        }
        const proposal = await step.do(name('propose-invite'), () =>
          io.propose('invite', {
            title: `${title}`,
            startIso: new Date(bookingMs).toISOString(),
            endIso: new Date(bookingMs + BOOKING_SPAN_MS).toISOString(),
            attendees: found.emails,
            location: place?.address ?? null,
          }),
        );
        await step.do(name('invite-text'), () =>
          io.send(
            `Запросити ${names.join(', ')} на ${kyivClock(bookingMs)} у ${title} (Calendar-запрошення)?${found.notes.length ? `\n${found.notes.join('\n')}` : ''}`,
            proposal ? /** @type {any} */ (proposal.buttons) : undefined,
          ),
        );
        continue;
      }
    }

    // 6. «Як було?» через 2 год після кінця (S-1-11).
    await run();
    await step.sleepUntil('after-end', endMs + AFTER_END_MS);
    await step.do('ask-rating', () =>
      io.send(`Як було у ${title}?`, [
        buttons(chainId, [
          ['⭐1', 'r1'],
          ['⭐2', 'r2'],
          ['⭐3', 'r3'],
          ['⭐4', 'r4'],
          ['⭐5', 'r5'],
        ]),
        buttons(chainId, [['Пропустити', 'rskip']]),
      ]),
    );
    const rated = await waitFor('rating', WAIT_VENUE_MS);
    await step.do('finish', async () => {
      const stars =
        rated?.action === 'rating' && Number.isInteger(rated.stars) ? Number(rated.stars) : null;
      if (place) {
        await db(env)
          .prepare(
            'UPDATE places SET rating_owner = COALESCE(?, rating_owner), visits = visits + 1 WHERE place_id = ?',
          )
          .bind(stars, place.place_id)
          .run();
      }
      // json_patch: null стирає ключ, тож оцінка пишеться лише коли є.
      await patchTableState(env, chainId, 'done', {
        awaiting: null,
        nudge: null,
        ...(stars != null ? { rating: stars } : {}),
      });
      if (stars != null) await io.send(`Записав ${stars}/5 для ${title}.`);
    });
    return { outcome: 'done', place_id: place?.place_id ?? null };
  } catch (e) {
    if (e instanceof Cancelled) {
      await step.do('cancelled', async () => {
        await patchTableState(env, chainId, 'cancelled', { awaiting: null, nudge: null });
        await io.send(`Скасував ланцюг «столик у ${state.venue}».`);
      });
      return { outcome: 'cancelled' };
    }
    throw e;
  }
}

// ── Помічники ──────────────────────────────────────────────────────────────

/** Назва з state_json (битий JSON - порожньо). @param {string | null} stateJson */
function venueOf(stateJson) {
  try {
    return String(JSON.parse(stateJson ?? '{}')?.venue ?? '');
  } catch {
    return '';
  }
}

/** «вул. Вірменська 6, Львів» → « · вул. Вірменська 6». @param {string | null} address */
export function streetOf(address) {
  if (!address) return '';
  const first = address.split(',')[0]?.trim() ?? '';
  return first ? ` · ${first.slice(0, 40)}` : '';
}

/** Телефон із тексту (≥ 7 цифр, можливий +). @param {string} text */
export function phoneOf(text) {
  const m = text.match(/\+?[\d\s()-]{7,}/);
  if (!m) return null;
  const digits = m[0].replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? digits : null;
}

/**
 * «19:00» / «о 19» / «19» / «на 19.30» → мс того ж київського дня, що й
 * нагадування (або наступного, якщо вже минуло).
 * @param {string} text @param {number} atMs @param {number} nowMs
 */
export function parseClock(text, atMs, nowMs) {
  const m = text.match(/(\d{1,2})(?:[:.](\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2] ?? 0);
  if (h > 23 || mm > 59) return null;
  const hhmm = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  let ms = kyivMs(kyivDateKey(new Date(atMs)), hhmm);
  if (ms == null) return null;
  if (ms < nowMs) ms += 86_400_000;
  return ms;
}

// ── Бойове io ──────────────────────────────────────────────────────────────

/**
 * @param {Env} env @param {string} chainId
 * @returns {Promise<TableIo>}
 */
export async function productionIo(env, chainId) {
  const state = await loadState(env, chainId);
  const chatId = state.chat_id ?? env.TELEGRAM_CHAT_ID ?? null;
  const threadId =
    state.thread_id === 'dm' ? null : (state.thread_id ?? env.TOPIC_ASSISTANT ?? null);
  if (chatId == null) throw new Error('TELEGRAM_CHAT_ID не задано');
  const post = async (
    /** @type {'send' | 'contact' | 'venue'} */ kind,
    /** @type {Record<string, unknown>} */ payload,
    /** @type {unknown} */ btns,
    /** @type {import('../tg/markdown.mjs').MdPart[] | undefined} */ parts = undefined,
  ) => {
    await enqueueOutbox(
      env,
      {
        chatId,
        threadId,
        kind,
        payload: { ...payload, ...(btns ? { reply_markup: { inline_keyboard: btns } } : {}) },
        parts,
      },
      Date.now(),
    );
    await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
      console.error(`table-chain ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
    });
  };
  return {
    now: () => Date.now(),
    send: (text, btns) => post('send', {}, btns, renderMdParts(text)),
    sendContact: (phone, name, btns) =>
      post('contact', { phone_number: phone, first_name: name }, btns),
    sendVenue: (lat, lon, title, address, btns) =>
      post('venue', { latitude: lat, longitude: lon, title, address }, btns),
    search: async (query) =>
      (await placesSearch(env, { query, city: state.city, near: null }, Date.now())).places,
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
      const io = await productionIo(env, params.chainId);
      return await runTableChain(env, params, step, io);
    } catch (/** @type {any} */ e) {
      console.error(`table chain ${params.chainId} впав`, e?.message);
      await setChainState(env, params.chainId, { status: 'failed', awaiting: null }).catch(
        () => {},
      );
      throw e;
    }
  }
}
