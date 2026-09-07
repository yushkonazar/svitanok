// TripChain (07 §6, S-5-5…S-5-10, етап 5 PR-4): поїздка від створення до
// «як пройшло». Старт із чату (chain.start kind=trip через policy, T0 з
// «↩»): рядок `trips` + чекліст за способом і країною + інстанс Workflow.
//
// Машина станів: розклад блоків рахується з дат (07 §6: до поїздки < 30 днів
// T-30 зливається в «Зараз», < 7 - T-30 і T-7 разом), далі T-1 ввечері,
// «пора виходити» за 2 год до виїзду з перерахунком ETA і, після повернення,
// «як пройшло, скільки витратив». Між блоками ланцюг чекає події `trip`:
// ✅ пункт чекліста (done-item), «Змінити дати» (change-date - розклад
// перераховується), «Скасувати» (cancel), текст власника (ціна квитка,
// нові дати, витрати). Імена кроків - з індексами раунду й блоку: Workflow
// відтворює код із початку після кожного пробудження.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { kyivDateKey, kyivClock } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { kyivMs } from '../day-plan/store.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { patchChainState, readChainState, waitOrNull } from './state.mjs';
import { chainTarget } from './table.mjs';
import { formatMoney } from './price.mjs';
import {
  loadChecklist,
  blocksDueNow,
  renderBlock,
  parseState,
  BLOCKS,
} from '../trips/checklist.mjs';
import { listVehicles, fuelPrice, carCostLine } from '../trips/cost.mjs';
import { routesEta, geocodeAddress } from '../adapters/maps.mjs';
import { forecastForDates, forecastLine, FORECAST_DAYS } from '../adapters/weather.mjs';
import { resolveWaypoint } from '../tools/places.mjs';

export const CHAIN_KIND = 'trip';
export const TRIP_MODES = ['car', 'bus', 'train', 'plane'];
/** Час блоків за Києвом (07 §6). */
const BLOCK_AT = { t30: '10:00', t7: '10:00', t1: '19:00' };
/** Виїзд, якщо власник не назвав години. */
const DEFAULT_DEPART = '09:00';
/** «Пора виходити» - за стільки до виїзду (07 §6). */
const LEAVE_BEFORE_MS = 2 * 3_600_000;
/** Підсумок - наступного дня після повернення о 10:00. */
const AFTER_AT = '10:00';
/** Стелі ітерацій (детерміновані імена кроків, не логіка). */
const ROUNDS_MAX = 4;
const EVENTS_PER_WINDOW = 12;

/**
 * @typedef {{
 *   now: () => number,
 *   send: (text: string, buttons?: { text: string, callback_data: string }[][]) => Promise<void>,
 *   checklist: (key: string) => Promise<Record<string, import('../trips/checklist.mjs').ChecklistItem[]>>,
 *   readDone: () => Promise<string[]>,
 *   markDone: (id: string) => Promise<void>,
 *   route: (from: string, to: string, mode: string) => Promise<{ distance_m: number, duration_min: number } | null>,
 *   carCost: (vehicleKey: string | null, distanceM: number | null) => Promise<string>,
 *   weather: (place: string, dates: string[]) => Promise<string[]>,
 *   saveCost: (patch: Record<string, unknown>) => Promise<void>,
 *   saveDates: (from: string, to: string | null) => Promise<void>,
 *   finish: (status: string) => Promise<void>,
 * }} TripIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   sleepUntil: (name: string, ms: number) => Promise<void>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} TripStep
 * @typedef {{ trip_id: string, to_text: string, from_city: string | null, country: string | null,
 *   date_from: string, date_to: string | null, mode: string, vehicle_key: string | null,
 *   checklist_key: string, depart_at: string | null, chat_id: number | string | null,
 *   thread_id: string | null, awaiting: string | null }} TripState
 * @typedef {{ chainId: string, state?: TripState }} TripParams
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - ланцюг недоступний');
  return env.DB;
}

/** «12.09». @param {string} date */
function ddmm(date) {
  const [, m, d] = date.split('-');
  return `${d}.${m}`;
}

/** Дати поїздки як список київських днів (для погоди). @param {string} from @param {string | null} to */
export function tripDates(from, to) {
  const dates = [from];
  let cur = from;
  for (let i = 0; i < 14 && to && cur < to; i += 1) {
    cur = addDaysToDateKey(cur, 1);
    dates.push(cur);
  }
  return dates;
}

/** Скільки діб до виїзду (київські дати). @param {string} dateFrom @param {number} nowMs */
export function daysUntil(dateFrom, nowMs) {
  const today = kyivDateKey(new Date(nowMs));
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dateFrom}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Розклад повідомлень (07 §6): [{at, blocks}] - перший може бути «зараз»
 * (поїздка близько), далі T-7 і T-1 у свій час.
 * @param {string} dateFrom @param {number} nowMs
 */
export function schedule(dateFrom, nowMs) {
  const left = daysUntil(dateFrom, nowMs);
  /** @type {{ at: number, blocks: string[] }[]} */
  const out = [];
  const at = (/** @type {string} */ date, /** @type {string} */ hhmm) =>
    kyivMs(date, hhmm) ?? nowMs;
  const t30 = at(addDaysToDateKey(dateFrom, -30), BLOCK_AT.t30);
  const t7 = at(addDaysToDateKey(dateFrom, -7), BLOCK_AT.t7);
  const t1 = at(addDaysToDateKey(dateFrom, -1), BLOCK_AT.t1);
  const now = blocksDueNow(left);
  if (now.length) out.push({ at: nowMs, blocks: now });
  if (t30 > nowMs) out.push({ at: t30, blocks: ['t30'] });
  if (t7 > nowMs && !now.includes('t7')) out.push({ at: t7, blocks: ['t7'] });
  if (t1 > nowMs && !now.includes('t1')) out.push({ at: t1, blocks: ['t1'] });
  return out.sort((a, b) => a.at - b.at);
}

/** «3 год 20 хв» із хвилин Routes. @param {number} min */
export function hoursWord(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} год${m ? ` ${m} хв` : ''}` : `${m} хв`;
}

/** Заголовок блоку для власника. @param {string} block @param {string} to @param {string} dateFrom */
function blockTitle(block, to, dateFrom) {
  const when = { t30: 'за місяць', t7: 'за тиждень', t1: 'завтра виїзд', road: 'у дорозі' }[block];
  return `Поїздка «${to}» ${ddmm(dateFrom)} - ${when}:`;
}

// ── Старт із чату ──────────────────────────────────────────────────────────

/** Країна поза Україною - потрібен «кордонний» чекліст. @param {unknown} country */
export function isAbroad(country) {
  const c = String(country ?? '')
    .trim()
    .toLowerCase();
  return c !== '' && !['україна', 'ukraine', 'ua'].includes(c);
}

/** Дата у форматі YYYY-MM-DD? @param {unknown} v */
function dateKeyOf(v) {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Виконавець chain.start(kind=trip): payload {to, date_from, date_to?, mode,
 * from_city?, country?, vehicle_key?, depart_at?, trip_id?}. З trip_id -
 * зміна дат наявної поїздки (S-5-9: подія change-date у живий ланцюг).
 * @param {Env} env @param {Record<string, unknown>} payload @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 */
export async function startTripChain(env, payload, nowMs, ctx) {
  if (!env.TRIP_CHAIN) throw new Error('привʼязки TRIP_CHAIN (Workflow) немає');
  const dateFrom = dateKeyOf(payload.date_from);
  if (!dateFrom) throw new Error('date_from обовʼязковий у форматі YYYY-MM-DD');
  const dateTo = dateKeyOf(payload.date_to);
  if (dateTo && dateTo < dateFrom) throw new Error('date_to раніше за date_from');
  if (payload.trip_id) return changeTripDates(env, String(payload.trip_id), dateFrom, dateTo);
  const to = String(payload.to ?? '')
    .trim()
    .slice(0, 120);
  if (!to) throw new Error('to обовʼязковий (куди їдемо)');
  const mode = String(payload.mode ?? '');
  if (!TRIP_MODES.includes(mode)) {
    throw new Error(`невідомий mode «${mode}» (чинні: ${TRIP_MODES.join(', ')})`);
  }
  const country = payload.country == null ? null : String(payload.country).trim().slice(0, 60);
  const abroad = isAbroad(country);
  const checklistKey = (await import('../trips/checklist.mjs')).pickChecklistKey({ mode, abroad });
  const tripId = crypto.randomUUID();
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(
      `INSERT INTO trips (id, wish_id, from_city, to_text, country, date_from, date_to, mode, vehicle_key,
         checklist_key, cost_json, checklist_state_json, workflow_id, status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'active')`,
    )
    .bind(
      tripId,
      payload.from_city == null ? null : String(payload.from_city).trim().slice(0, 60),
      to,
      country,
      dateFrom,
      dateTo,
      mode,
      payload.vehicle_key == null ? null : String(payload.vehicle_key).slice(0, 64),
      checklistKey,
      JSON.stringify({ done: [] }),
      chainId,
    )
    .run();
  /** @type {TripState} */
  const state = {
    trip_id: tripId,
    to_text: to,
    from_city: payload.from_city == null ? null : String(payload.from_city),
    country,
    date_from: dateFrom,
    date_to: dateTo,
    mode,
    vehicle_key: payload.vehicle_key == null ? null : String(payload.vehicle_key),
    checklist_key: checklistKey,
    depart_at: payload.depart_at == null ? null : String(payload.depart_at).slice(0, 5),
    chat_id: ctx.chatId ?? null,
    thread_id: ctx.threadId == null ? null : String(ctx.threadId),
    awaiting: null,
  };
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(chainId, CHAIN_KIND, chainId, JSON.stringify(state), iso, iso)
    .run();
  try {
    await env.TRIP_CHAIN.create({ id: chainId, params: { chainId } });
  } catch (/** @type {any} */ e) {
    await patchChainState(env, chainId, 'failed', { awaiting: null }, { nowMs });
    throw new Error(`Workflow поїздки не стартував: ${String(e?.message ?? e)}`, { cause: e });
  }
  const left = daysUntil(dateFrom, nowMs);
  const vehicle = state.vehicle_key ? ` , авто ${state.vehicle_key}` : '';
  return {
    result: {
      trip_id: tripId,
      chain_id: chainId,
      checklist: checklistKey,
      text:
        `Поїздка створена: ${ddmm(dateFrom)}${dateTo ? `-${ddmm(dateTo)}` : ''}, ` +
        `${state.from_city ? `${state.from_city} → ` : ''}${to}, ${modeWord(mode)}${vehicle}. ` +
        `Чекліст ${checklistKey}: ${left > 30 ? `перший блок - за ${left - 30} ${left - 30 === 1 ? 'день' : 'днів'}` : 'перший блок надішлю зараз'}.`,
      note: 'ланцюг далі веде ядро кнопками; власнику скажи саме text',
    },
    prev: { chain_id: chainId, trip_id: tripId },
  };
}

/** @param {string} mode */
export function modeWord(mode) {
  return { car: 'авто', bus: 'автобус', train: 'потяг', plane: 'літак' }[mode] ?? mode;
}

/**
 * Зміна дат наявної поїздки (S-5-9): рядок `trips` + подія change-date у
 * живий ланцюг, який перерахує сни.
 * @param {Env} env @param {string} tripId @param {string} dateFrom @param {string | null} dateTo
 */
export async function changeTripDates(env, tripId, dateFrom, dateTo) {
  const row = /** @type {{ id: string, to_text: string, workflow_id: string | null } | null} */ (
    await db(env)
      .prepare(`SELECT id, to_text, workflow_id FROM trips WHERE id = ? OR to_text LIKE ? LIMIT 1`)
      .bind(tripId, `%${tripId.replace(/[%_]/g, '')}%`)
      .first()
  );
  if (!row) throw new Error(`поїздки «${tripId}» немає`);
  await db(env)
    .prepare('UPDATE trips SET date_from = ?, date_to = ? WHERE id = ?')
    .bind(dateFrom, dateTo, row.id)
    .run();
  let delivered = false;
  if (row.workflow_id && env.TRIP_CHAIN) {
    try {
      const instance = await env.TRIP_CHAIN.get(String(row.workflow_id));
      await instance.sendEvent({
        type: 'trip',
        payload: { action: 'change-date', date_from: dateFrom, date_to: dateTo },
      });
      delivered = true;
    } catch (/** @type {any} */ e) {
      console.error(`trip-chain ${row.workflow_id}: change-date не доставлено`, e?.message);
    }
  }
  return {
    result: {
      trip_id: row.id,
      changed: true,
      rescheduled: delivered,
      text: `Переніс поїздку «${row.to_text}» на ${ddmm(dateFrom)}${dateTo ? `-${ddmm(dateTo)}` : ''}${delivered ? '' : ' (нагадування перерахую наступним блоком)'}`,
    },
    prev: undefined,
  };
}

/** Активна поїздка: за id/назвою або найсвіжіша. @param {Env} env @param {string | null} ref */
export async function findActiveTrip(env, ref) {
  const row = /** @type {any} */ (
    await db(env)
      .prepare(
        `SELECT id, to_text, workflow_id FROM trips WHERE status = 'active'
           AND (? IS NULL OR id = ? OR to_text LIKE ?) ORDER BY date_from LIMIT 1`,
      )
      .bind(ref ?? null, ref ?? null, ref ? `%${ref.replace(/[%_]/g, '')}%` : '')
      .first()
  );
  return row
    ? { id: String(row.id), to: String(row.to_text ?? ''), chainId: row.workflow_id }
    : null;
}

/**
 * Скасування поїздки (chain.cancel kind=trip, «↩»): рядок trips - cancelled,
 * ланцюг - cancelled + подія.
 * @param {Env} env @param {string | null} ref @param {number} nowMs
 */
export async function cancelTripChain(env, ref, nowMs) {
  const trip = await findActiveTrip(env, ref);
  if (!trip) return null;
  await db(env).prepare(`UPDATE trips SET status = 'cancelled' WHERE id = ?`).bind(trip.id).run();
  if (trip.chainId) {
    await patchChainState(env, String(trip.chainId), 'cancelled', { awaiting: null }, { nowMs });
    try {
      const instance = await env.TRIP_CHAIN?.get(String(trip.chainId));
      await instance?.sendEvent({ type: 'trip', payload: { action: 'cancel' } });
    } catch (/** @type {any} */ e) {
      console.error(`trip-chain ${trip.chainId}: подія cancel не доставлена`, e?.message);
    }
  }
  return trip;
}

/** @param {Env} env @param {string} chainId @returns {Promise<TripState>} */
export async function loadTripState(env, chainId) {
  const row = await readChainState(env, chainId);
  if (!row) throw new Error(`ланцюга ${chainId} немає`);
  return /** @type {TripState} */ (row.state);
}

// ── Машина станів ──────────────────────────────────────────────────────────

class Cancelled extends Error {}
class Rescheduled extends Error {}

/**
 * @param {Env} env @param {TripParams} params @param {TripStep} step @param {TripIo} io
 */
export async function runTripChain(env, params, step, io) {
  const { chainId } = params;
  let state = params.state ?? (await step.do('state', () => loadTripState(env, chainId)));
  // Стан 'waiting' + awaiting_since: реєстр ланцюгів віддає текст власника
  // тому, хто спитав останнім (registry.findAwaitingChain).
  const await_ = async (/** @type {string} */ label, /** @type {string | null} */ awaiting) => {
    const ok = await step.do(label, () =>
      patchChainState(
        env,
        chainId,
        awaiting == null ? 'running' : 'waiting',
        { awaiting, awaiting_since: awaiting == null ? null : new Date(io.now()).toISOString() },
        { unlessCancelled: true, nowMs: io.now() },
      ),
    );
    if (!ok) throw new Cancelled();
  };

  for (let round = 0; round < ROUNDS_MAX; round += 1) {
    const rk = `r${round}`;
    try {
      const items = await step.do(`${rk}-checklist`, () => io.checklist(state.checklist_key));
      const plan = schedule(state.date_from, io.now());
      for (const [bi, point] of plan.entries()) {
        const label = `${rk}-b${bi}`;
        if (point.at > io.now()) await step.sleepUntil(`${label}-sleep`, point.at);
        await await_(`${label}-run`, 'checklist');
        for (const [gi, block] of point.blocks.entries()) {
          const extra = await step.do(`${label}-x${gi}`, () => blockExtras(io, state, block));
          const done = await step.do(`${label}-done${gi}`, () => io.readDone());
          const view = renderBlock(chainId, {
            block,
            items: items[block] ?? [],
            done,
            title: blockTitle(block, state.to_text, state.date_from),
            extra,
          });
          await step.do(`${label}-send${gi}`, () => io.send(view.text, view.buttons));
        }
        const until =
          plan[bi + 1]?.at ??
          kyivMs(state.date_from, state.depart_at ?? DEFAULT_DEPART) ??
          io.now();
        state = await waitWindow(step, io, env, chainId, `${label}-w`, until, state);
      }

      // День виїзду: «пора виходити» за 2 год + перерахунок ETA (07 §6).
      const departMs = kyivMs(state.date_from, state.depart_at ?? DEFAULT_DEPART) ?? io.now();
      if (departMs - LEAVE_BEFORE_MS > io.now()) {
        await step.sleepUntil(`${rk}-leave-sleep`, departMs - LEAVE_BEFORE_MS);
      }
      const eta = await step.do(`${rk}-leave-eta`, () =>
        io.route(state.from_city ?? 'home', state.to_text, state.mode),
      );
      await step.do(`${rk}-leave-send`, () =>
        io.send(
          `Пора виходити: виїзд о ${kyivClock(departMs)}${eta ? `, у дорозі ~${hoursWord(eta.duration_min)} (${Math.round(eta.distance_m / 1000)} км)` : ''}. Дорожній чекліст - нижче.`,
          [
            [
              { text: '🗓 Змінити дати', callback_data: `c:${chainId}:newdate` },
              { text: '✖ Скасувати', callback_data: `c:${chainId}:cancel` },
            ],
          ],
        ),
      );
      const roadDone = await step.do(`${rk}-road-done`, () => io.readDone());
      const road = renderBlock(chainId, {
        block: 'road',
        items: items.road ?? [],
        done: roadDone,
        title: blockTitle('road', state.to_text, state.date_from),
      });
      await step.do(`${rk}-road-send`, () => io.send(road.text, road.buttons));

      // Після повернення (S-5-10): «як пройшло, скільки витратив».
      const backMs =
        kyivMs(addDaysToDateKey(state.date_to ?? state.date_from, 1), AFTER_AT) ?? io.now();
      state = await waitWindow(step, io, env, chainId, `${rk}-trip-w`, backMs, state);
      await await_(`${rk}-back-ask`, 'spent');
      await step.do(`${rk}-back-say`, async () => {
        await io.send(
          `Як пройшла поїздка «${state.to_text}»? Скільки витратив? (напиши сумою, напр. «3 500»)`,
        );
      });
      const answer = await waitOrNull(step, `${rk}-back-wait`, 'trip', 3 * 86_400_000);
      if (answer?.action === 'cancel') throw new Cancelled();
      await step.do(`${rk}-back-save`, async () => {
        const spent = answer?.action === 'text' ? moneyOf(String(answer.text ?? '')) : null;
        if (spent != null) await io.saveCost({ actual: spent });
        await io.finish('done');
        await patchChainState(env, chainId, 'done', { awaiting: null }, { nowMs: io.now() });
        if (spent != null) await io.send(`Записав витрати: ${formatMoney(spent, 'UAH')}.`);
      });
      return { outcome: 'done', trip_id: state.trip_id };
    } catch (e) {
      if (e instanceof Rescheduled) {
        state = await step.do(`${rk}-reload`, () => loadTripState(env, chainId));
        continue;
      }
      if (e instanceof Cancelled) {
        await step.do(`${rk}-cancelled`, async () => {
          await patchChainState(env, chainId, 'cancelled', { awaiting: null }, { nowMs: io.now() });
          await io.finish('cancelled');
          await io.send(`Скасував поїздку «${state.to_text}».`);
        });
        return { outcome: 'cancelled' };
      }
      throw e;
    }
  }
  await step.do('rounds-exhausted', () =>
    patchChainState(env, chainId, 'done', { awaiting: null }, { nowMs: io.now() }),
  );
  return { outcome: 'abandoned' };
}

/**
 * Вікно очікування до наступного блоку: ✅ пунктів, зміна дат, скасування,
 * текст (ціна квитка). Повертає (можливо оновлений) стан.
 * @param {TripStep} step @param {TripIo} io @param {Env} env @param {string} chainId
 * @param {string} label @param {number} untilMs @param {TripState} state
 * @returns {Promise<TripState>}
 */
async function waitWindow(step, io, env, chainId, label, untilMs, state) {
  for (let i = 0; i < EVENTS_PER_WINDOW && io.now() < untilMs; i += 1) {
    const ev = await waitOrNull(step, `${label}-${i}`, 'trip', untilMs - io.now());
    if (!ev) return state;
    if (ev.action === 'cancel') throw new Cancelled();
    if (ev.action === 'change-date') {
      await step.do(`${label}-${i}-date`, async () => {
        const from = String(ev.date_from ?? state.date_from);
        const to = ev.date_to == null ? state.date_to : String(ev.date_to);
        await io.saveDates(from, to);
        await patchChainState(
          env,
          chainId,
          'running',
          { date_from: from, date_to: to },
          { nowMs: io.now() },
        );
        await io.send(
          `Дати оновив: ${ddmm(from)}${to ? `-${ddmm(to)}` : ''}. Нагадування перерахував.`,
        );
      });
      throw new Rescheduled();
    }
    if (ev.action === 'ask-date') {
      await step.do(`${label}-${i}-askdate`, () =>
        io.send('Які нові дати? Напиши, наприклад «з 12 по 15 жовтня» - і я перенесу поїздку.'),
      );
      continue;
    }
    if (ev.action === 'done' && typeof ev.item === 'string') {
      await step.do(`${label}-${i}-done`, () => io.markDone(String(ev.item)));
      continue;
    }
    if (ev.action === 'text') {
      const spent = moneyOf(String(ev.text ?? ''));
      if (spent != null) {
        await step.do(`${label}-${i}-cost`, async () => {
          await io.saveCost({ ticket: spent });
          await io.send(`Записав до вартості поїздки: ${formatMoney(spent, 'UAH')}.`);
        });
      }
    }
  }
  return state;
}

/** Сума з тексту власника («3 500», «3 500 грн») у копійках; null - не сума. @param {string} text */
export function moneyOf(text) {
  const m = String(text ?? '')
    .replace(/\s/g, '')
    .match(/^\d+(?:[.,]\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/**
 * Рядки, які ядро додає до блоку: вартість авто (T-30) і погода на дати
 * (T-7, лише в межах горизонту прогнозу).
 * @param {TripIo} io @param {TripState} state @param {string} block
 * @returns {Promise<string[]>}
 */
async function blockExtras(io, state, block) {
  /** @type {string[]} */
  const extra = [];
  if (block === 't30' && state.mode === 'car') {
    const eta = await io.route(state.from_city ?? 'home', state.to_text, 'car');
    extra.push(await io.carCost(state.vehicle_key, eta?.distance_m ?? null));
  }
  if (block === 't7') {
    const dates = tripDates(state.date_from, state.date_to);
    const lines = await io.weather(state.to_text, dates);
    extra.push(
      lines.length
        ? `Погода: ${lines.join('; ')}`
        : `Погода на ${ddmm(state.date_from)} буде ближче до дати (прогноз - ${FORECAST_DAYS} діб).`,
    );
  }
  return extra;
}

// ── Бойове io ──────────────────────────────────────────────────────────────

/**
 * @param {Env} env @param {string} chainId @param {TripState} state
 * @returns {TripIo}
 */
export function productionIo(env, chainId, state) {
  const { chatId, threadId } = chainTarget(env, state);
  const send = async (/** @type {string} */ text, /** @type {unknown} */ btns = undefined) => {
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
      console.error(`trip-chain ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
    });
  };
  return {
    now: () => Date.now(),
    send,
    checklist: (key) => loadChecklist(env, key),
    readDone: async () => {
      const row = /** @type {{ checklist_state_json: string | null } | null} */ (
        await db(env)
          .prepare('SELECT checklist_state_json FROM trips WHERE id = ?')
          .bind(state.trip_id)
          .first()
      );
      return parseState(row?.checklist_state_json ?? null);
    },
    markDone: async (id) => {
      await db(env)
        .prepare(
          `UPDATE trips SET checklist_state_json = json_set(COALESCE(checklist_state_json, '{"done":[]}'), '$.done[#]', ?)
           WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(checklist_state_json, '$.done')) WHERE value = ?)`,
        )
        .bind(id, state.trip_id, id)
        .run();
    },
    route: async (
      /** @type {string} */ from,
      /** @type {string} */ to,
      /** @type {string} */ mode,
    ) => {
      try {
        const nowMs = Date.now();
        const fromWp = await resolveWaypoint(env, from, nowMs);
        return await routesEta(
          env,
          { from: fromWp, to: { address: to }, mode: mode === 'car' ? 'car' : 'transit' },
          nowMs,
        );
      } catch (/** @type {any} */ e) {
        console.error(`trip-chain ${chainId}: маршрут не порахований`, e?.message);
        return null;
      }
    },
    carCost: async (vehicleKey, distanceM) => {
      const vehicles = await listVehicles(env);
      const vehicle = vehicleKey
        ? (vehicles.find((v) => v.key === vehicleKey) ?? null)
        : (vehicles[0] ?? null);
      const price = await fuelPrice(env, vehicle?.fuel ?? null);
      return carCostLine({ vehicle, price, distanceM });
    },
    weather: async (place, dates) => {
      try {
        const geo = await geocodeAddress(env, place, Date.now());
        if (!geo.found) return [];
        const forecast = await forecastForDates(env, { lat: geo.lat, lon: geo.lon }, dates);
        return forecast.map(forecastLine);
      } catch (/** @type {any} */ e) {
        console.error(`trip-chain ${chainId}: погода не отримана`, e?.message);
        return [];
      }
    },
    saveCost: async (patch) => {
      await db(env)
        .prepare(
          `UPDATE trips SET cost_json = json_patch(COALESCE(cost_json, '{}'), ?) WHERE id = ?`,
        )
        .bind(JSON.stringify(patch), state.trip_id)
        .run();
    },
    saveDates: async (from, to) => {
      await db(env)
        .prepare('UPDATE trips SET date_from = ?, date_to = ? WHERE id = ?')
        .bind(from, to, state.trip_id)
        .run();
    },
    finish: async (status) => {
      await db(env)
        .prepare('UPDATE trips SET status = ? WHERE id = ?')
        .bind(status, state.trip_id)
        .run();
    },
  };
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class TripChain extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<TripParams>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {TripParams} */ (event.payload);
    try {
      const state = await step.do('state', () => loadTripState(env, params.chainId));
      return await runTripChain(
        env,
        { ...params, state },
        step,
        productionIo(env, params.chainId, state),
      );
    } catch (/** @type {any} */ e) {
      console.error(`trip chain ${params.chainId} впав`, e?.message);
      await patchChainState(env, params.chainId, 'failed', { awaiting: null }).catch(
        (/** @type {any} */ e2) =>
          console.error(`trip chain ${params.chainId}: статус failed не записано`, e2?.message),
      );
      throw e;
    }
  }
}

export { BLOCKS };
