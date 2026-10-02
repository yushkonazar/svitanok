// plan.* (07 §4, ADR-035, S-P-14): інструменти плану дня для чату - T0 з
// «↩» для accept. Розкладку рахує ядро (slots.mjs), сховище - store.mjs;
// тут лише контракт аргументів, читання календаря/енергії й знімки для undo.
//   plan.intent  {date?, items[]}        - пункти → розкладка → чернетка
//   plan.draft   {date}                  - перерахувати чернетку з наявних пунктів
//   plan.accept  {date, calendar?}       - прийняти (нагадування; календар - T1)
//   plan.update  {date, done[], moves[], drop[]} - зміни вдень
//   plan.review  {date, carry[]}          - огляд і перенос (["all"] - усі відкриті)

import {
  readCalendarRange,
  getCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  createCalendarEvent,
} from '../../google.mjs';
import { loadStats } from '../../kv-store.mjs';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { applyPolicy } from '../policy/proposals.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import {
  computeSlots,
  formatDraft,
  energyBySlot,
  hhmmToMin,
  minToHhmm,
} from './../day-plan/slots.mjs';
import {
  readDayPlanConfig,
  getDayPlan,
  listItems,
  normalizeItem,
  normalizePlanItems,
  replaceItems,
  upsertDayPlan,
  acceptPlan,
  undoAccept,
  updateItems,
  undoUpdateItems,
  reviewPlan,
  carryItems,
  resolveItemRef,
  nextPlannedDay,
  kyivMs,
  ITEMS_MAX,
} from '../day-plan/store.mjs';

/** «сьогодні»/«завтра»/YYYY-MM-DD → дата; порожньо = сьогодні. @param {unknown} raw @param {number} nowMs */
export function resolvePlanDate(raw, nowMs) {
  const today = kyivDateKey(new Date(nowMs));
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s || s === 'сьогодні' || s === 'today') return today;
  if (s === 'завтра' || s === 'tomorrow') return addDaysToDateKey(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`date «${String(raw)}»: сьогодні, завтра або YYYY-MM-DD`);
}

/**
 * Розкладка з наявних/переданих пунктів → чернетка в D1 + текст.
 * @param {Env} env @param {string} date @param {ReturnType<typeof normalizeItem>[]} items @param {number} nowMs
 */
async function draftFor(env, date, items, nowMs) {
  const config = await readDayPlanConfig(env, nowMs);
  const [calendar, stats] = await Promise.all([readCalendarRange(env, date, date), loadStats(env)]);
  if (calendar == null)
    throw new Error('календар недоступний (токен або мережа) - без нього розкладка сліпа');
  const events = calendar.map((e) => ({
    title: String(e.title ?? ''),
    startMin: typeof e.startMs === 'number' ? kyivMinuteOfDay(new Date(e.startMs)) : null,
    endMin: typeof e.endMs === 'number' ? kyivMinuteOfDay(new Date(e.endMs)) : null,
    transparent: e.transparent,
  }));
  const slots = computeSlots({
    date,
    items,
    events,
    settings: config.settings,
    habits: config.habits,
    energy: energyBySlot(stats.checkins ?? {}),
    nowMin: date === kyivDateKey(new Date(nowMs)) ? kyivMinuteOfDay(new Date(nowMs)) : null,
  });
  await replaceItems(env, date, slots, items);
  await upsertDayPlan(
    env,
    date,
    { status: 'draft', fill_ratio: config.settings.fill_ratio },
    nowMs,
  );
  return {
    date,
    text: formatDraft(date, slots, events),
    placed: slots.placed,
    flexible: slots.flexible,
  };
}

/**
 * plan.intent (T0): пункти від моделі → чернетка.
 * @param {Env} env
 * @param {{ date?: string, items: unknown }} args
 * @param {number} nowMs
 */
export async function runPlanIntent(env, args, nowMs) {
  const date = resolvePlanDate(args.date, nowMs);
  if ((await getDayPlan(env, date))?.status === 'accepted')
    throw new Error(`План на ${date} уже погоджено й записано. Не замінюю його чернеткою.`);
  if (!Array.isArray(args.items) || args.items.length === 0)
    throw new Error('items - непорожній список пунктів');
  if (args.items.length > ITEMS_MAX)
    throw new Error(`план містить понад ${ITEMS_MAX} справ; розділи їх на кілька повідомлень`);
  // id від моделі не приймаємо (те саме, що normalizeIntent у ланцюзі):
  // replaceItems робить INSERT OR REPLACE за глобальним id, і чужий id
  // перетягнув би рядок іншої дати разом із reminder_id.
  const items = normalizePlanItems(
    args.items.map((r) => /** @type {Record<string, unknown>} */ (r ?? {})),
  );
  await upsertDayPlan(env, date, { status: 'intent' }, nowMs);
  return { result: await draftFor(env, date, items, nowMs) };
}

/**
 * plan.draft (T0): перерахувати чернетку з пунктів, що вже в базі.
 * @param {Env} env @param {{ date?: string }} args @param {number} nowMs
 */
export async function runPlanDraft(env, args, nowMs) {
  const date = resolvePlanDate(args.date, nowMs);
  if ((await getDayPlan(env, date))?.status === 'accepted')
    throw new Error(
      `План на ${date} уже погоджено й записано. Не перераховую його без узгодження змін.`,
    );
  const rows = (await listItems(env, date)).filter((r) => r.status === 'planned');
  if (rows.length === 0) throw new Error(`на ${date} немає пунктів - спершу plan.intent`);
  const items = rows.map((r, i) =>
    normalizeItem(
      {
        id: r.id,
        title: r.title,
        kind: r.kind,
        est_min: r.est_min,
        hard_at: r.hard_at,
        hard_end: r.hard_end,
        not_before: r.not_before,
        not_after: r.not_after,
        after_item_id: r.after_item_id,
        overlap_with_item_id: r.overlap_with_item_id,
        floating: r.floating,
        optional: r.optional,
        notify: r.notify,
        role: r.role,
        deadline: r.deadline,
        place: r.place,
        priority: r.priority,
        carried_from: r.carried_from,
      },
      i,
    ),
  );
  return { result: await draftFor(env, date, items, nowMs) };
}

/**
 * plan.accept (T0 з «↩»): нагадування на блоки; calendar=true - пропозиції
 * T1 на кожен новий блок (S-P-12, виконавець календаря - етап 7).
 * @param {Env} env
 * @param {{ date?: string, calendar?: boolean }} args
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null,
 *   internal?: { tainted?: boolean } }} [ctx] - internal заповнює ЛИШЕ ядро
 */
export async function runPlanAccept(env, args, nowMs, ctx = {}) {
  const date = resolvePlanDate(args.date, nowMs);
  const plan = await getDayPlan(env, date);
  if (!plan) throw new Error(`на ${date} немає чернетки - спершу plan.intent`);
  // Адреса як у collection.export: chat прогону, а без нього - DM власника
  // для треду 'dm' і група для теми (ревʼю 05.09: група замість DM - помилка).
  const threadKey = ctx.threadId == null ? null : String(ctx.threadId);
  const isDm = threadKey === 'dm';
  const home = assistantHomeTarget(env);
  const chatId =
    ctx.chatId ?? (isDm ? (env.TELEGRAM_OWNER_USER_ID ?? null) : (home?.chatId ?? null));
  const res = await acceptPlan(env, date, nowMs, {
    chatId,
    threadId: ctx.threadId === 'dm' ? null : (ctx.threadId ?? home?.threadId ?? null),
  });
  /** @type {{ added: number, proposed: number, failed: string[] }} */
  let calendar = { added: 0, proposed: 0, failed: [] };
  if (args.calendar === true) {
    calendar = await calendarizeBlocks(
      env,
      date,
      res.items,
      nowMs,
      { chatId, threadId: isDm ? null : (ctx.threadId ?? home?.threadId ?? null) },
      (text, buttons) =>
        sendCalendarProposalRaw(
          env,
          { chatId, threadId: ctx.threadId ?? null },
          text,
          buttons,
          nowMs,
        ),
      // Позначка сесії йде наскрізь: під taint блоки в календар просять ✅.
      ctx.internal?.tainted === true,
    );
  }
  return {
    result: {
      date,
      status: 'accepted',
      reminders: res.reminders,
      calendar_added: calendar.added,
      // Скільки чекає ✅ (заплямована сесія): без цього числа модель читала б
      // «added 0» як «нічого не сталось» і повторювала виклик.
      calendar_proposed: calendar.proposed,
      // Названо вголос: мовчазний пропуск блока лишав би план наполовину
      // перенесеним, і власник дізнався б про це лише з календаря.
      calendar_failed: calendar.failed,
    },
    prev: { date, reminderIds: res.reminderIds, status: plan.status },
  };
}

/** Відкат accept. @param {Env} env @param {{ date: string, reminderIds: string[] }} snap @param {number} nowMs */
export async function undoPlanAccept(env, snap, nowMs) {
  await undoAccept(env, snap, nowMs);
}

/**
 * plan.update: factual starts/done are T0; moves/drop ask for confirmation
 * because they may modify a published Calendar event. D1 and Google have no
 * shared transaction, so a failed Google step compensates earlier steps and
 * restores the D1 snapshot. Never report a partial write as success.
 * @param {Env} env
 * @param {{ date?: string, starts?: { id: string, at?: string }[], done?: string[], moves?: { id: string, to: string }[], drop?: string[] }} args
 * @param {number} nowMs
 */
export async function runPlanUpdate(env, args, nowMs) {
  if (!env.DB) throw new Error('План дня недоступний — база даних не підключена');
  const db = env.DB;
  const date = resolvePlanDate(args.date, nowMs);
  const changes = {
    starts: args.starts ?? [],
    done: args.done ?? [],
    moves: args.moves ?? [],
    drop: args.drop ?? [],
  };
  const items = await listItems(env, date);
  const refs = [...changes.moves.map((m) => m.id), ...changes.drop];
  const seen = new Set();
  /** @type {{ item: any, event: any, kind: 'move' | 'drop', startIso?: string, endIso?: string }[]} */
  const calendarOps = [];
  for (const ref of refs) {
    const item = resolveItemRef(items, String(ref), `у плані ${date}`);
    if (seen.has(item.id))
      throw new Error(`«${item.title}» вказано кілька разів — обери одну зміну`);
    if (item.calendar_sync_pending)
      throw new Error(
        `«${item.title}» ще синхронізується з календарем. Спробуй після підтвердження синхронізації.`,
      );
    seen.add(item.id);
    if (!item.event_id) continue;
    const event = await getCalendarEvent(env, item.event_id);
    if (!event || event.startMs == null || event.endMs == null)
      throw new Error(
        `Не знайшов «${item.title}» у календарі. План не змінено; перевір подію й повтори.`,
      );
    if (event.hasAttendees)
      throw new Error(`У «${item.title}» є гості. Не змінюю їхнє запрошення через план дня.`);
    const expectedTitle =
      item.floating && item.est_min ? `${item.title} · ≈${item.est_min} хв у вікні` : item.title;
    if (
      event.title !== expectedTitle ||
      !item.window_start ||
      !item.window_end ||
      event.startMs !== kyivMs(date, item.window_start) ||
      event.endMs !== kyivMs(date, item.window_end)
    )
      throw new Error(`«${item.title}» уже змінено в календарі. План не змінено; спершу звір час.`);
    const move = changes.moves.find(
      (m) => resolveItemRef(items, String(m.id), `у плані ${date}`).id === item.id,
    );
    if (move) {
      const start = hhmmToMin(move.to);
      const length = (event.endMs - event.startMs) / 60_000;
      if (start == null || start + length >= 24 * 60)
        throw new Error(`«${item.title}» не вміщується в цей день — обери інший час`);
      const startMs = kyivMs(date, minToHhmm(start));
      const endMs = kyivMs(date, minToHhmm(start + length));
      if (startMs == null || endMs == null)
        throw new Error(`Не вдалося визначити новий час «${item.title}»`);
      calendarOps.push({
        item,
        event,
        kind: 'move',
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
      });
    } else calendarOps.push({ item, event, kind: 'drop' });
  }
  // Validate and persist the local side first. If validation or D1 fails,
  // Google is untouched. The subsequent compensation restores this snapshot.
  const out = await updateItems(env, date, changes, nowMs, true);
  const snap = { date, prev: out.prev };
  /** @type {typeof calendarOps} */
  const completed = [];
  let pending = 0;
  try {
    for (const op of calendarOps) {
      const result =
        op.kind === 'move'
          ? await updateCalendarEvent(env, {
              eventId: op.item.event_id,
              patch: {
                start: { dateTime: op.startIso, timeZone: 'Europe/Kyiv' },
                end: { dateTime: op.endIso, timeZone: 'Europe/Kyiv' },
              },
            })
          : await deleteCalendarEvent(env, { eventId: op.item.event_id });
      if (!result.ok) throw new Error(`Google Calendar не прийняв зміну «${op.item.title}»`);
      completed.push(op);
      try {
        const settled = await db
          .prepare(
            op.kind === 'drop'
              ? 'UPDATE plan_items SET event_id = NULL, calendar_sync_pending = 0, calendar_sync_pending_at = NULL, calendar_sync_alerted_at = NULL WHERE id = ? AND event_id = ? AND calendar_sync_pending = 1'
              : 'UPDATE plan_items SET calendar_sync_pending = 0, calendar_sync_pending_at = NULL, calendar_sync_alerted_at = NULL WHERE id = ? AND event_id = ? AND calendar_sync_pending = 1',
          )
          .bind(op.item.id, op.item.event_id)
          .run();
        if ((settled.meta?.changes ?? 0) !== 1) {
          const row = await db
            .prepare('SELECT calendar_sync_pending FROM plan_items WHERE id = ?')
            .bind(op.item.id)
            .first();
          if (row?.calendar_sync_pending) pending += 1;
        }
      } catch (/** @type {any} */ e) {
        // Google already accepted the change. Its idempotent retry is safer
        // than reporting failure and making a second mutation in compensation.
        pending += 1;
        console.error('plan: мітку календарної синхронізації не знято', e?.message);
      }
    }
  } catch (/** @type {any} */ error) {
    const restored = await restoreCalendarOps(env, completed, snap);
    try {
      await undoUpdateItems(env, snap);
    } catch (/** @type {any} */ dbError) {
      throw new Error(
        `Не вдалося узгодити план і календар. Перевір обидва записи: ${dbError.message}`,
        { cause: dbError },
      );
    }
    if (!restored)
      throw new Error(
        `Не вдалося повністю повернути календар після збою. Перевір змінені події: ${error.message}`,
        { cause: error },
      );
    throw new Error(`${error.message}. План і календар повернуто до попереднього стану.`, {
      cause: error,
    });
  }
  return {
    result: {
      date,
      changed: out.changed,
      calendar_changed: calendarOps.length,
      calendar_pending: pending,
    },
    prev: { ...snap, calendarOps },
  };
}

/** Restore Google before D1; recreated events receive a new event ID. */
/** @param {Env} env @param {any[]} ops @param {{ prev: any[] }} snap */
async function restoreCalendarOps(env, ops, snap) {
  let ok = true;
  for (const op of [...ops].reverse()) {
    if (op.kind === 'move') {
      const result = await updateCalendarEvent(env, {
        eventId: op.item.event_id,
        patch: {
          start: { dateTime: new Date(op.event.startMs).toISOString(), timeZone: 'Europe/Kyiv' },
          end: { dateTime: new Date(op.event.endMs).toISOString(), timeZone: 'Europe/Kyiv' },
        },
      });
      if (!result.ok) ok = false;
    } else {
      const result = await createCalendarEvent(env, {
        title: op.event.title,
        startIso: new Date(op.event.startMs).toISOString(),
        endIso: new Date(op.event.endMs).toISOString(),
        transparent: op.event.transparent,
        silent: true,
      });
      if (result.ok && result.id) {
        const prior = snap.prev.find((p) => p.id === op.item.id);
        if (prior) prior.event_id = result.id;
      } else {
        ok = false;
        const prior = snap.prev.find((p) => p.id === op.item.id);
        if (prior) prior.event_id = null;
      }
    }
  }
  return ok;
}

/** Відкат update. @param {Env} env @param {{ prev: any[], calendarOps?: any[] }} snap */
export async function undoPlanUpdate(env, snap) {
  if (snap.calendarOps?.length && !(await restoreCalendarOps(env, snap.calendarOps, snap)))
    throw new Error('Не вдалося повернути календар — план не змінено');
  await undoUpdateItems(env, snap);
}

/**
 * plan.review (T0): огляд і перенос. carry - id/назви пунктів, ["all"] - усі
 * відкриті; порожньо - лише огляд без переносу.
 * @param {Env} env
 * @param {{ date?: string, carry?: string[] }} args
 * @param {number} nowMs
 */
export async function runPlanReview(env, args, nowMs) {
  const date = resolvePlanDate(args.date, nowMs);
  const review = await reviewPlan(env, date);
  if (!Array.isArray(args.carry) || args.carry.length === 0) return { result: review };
  const config = await readDayPlanConfig(env);
  const to = nextPlannedDay(date, config.weekdays);
  const all = args.carry.length === 1 && args.carry[0] === 'all';
  const ids = all
    ? []
    : args.carry.map((ref) => resolveItemRef(review.open, ref, 'серед відкритих').id);
  const carried = await carryItems(env, date, to, ids, nowMs);
  return { result: { ...review, carried_to: to, carried: carried.carried, stale: carried.stale } };
}

/**
 * Текст під блоком, що поїхав у календар - спільний для plan.accept і ланцюга.
 * ⚠️ Від 08.09 подія без гостей створюється ОДРАЗУ (T0 з «↩»), тож це вже не
 * питання «додати?», а звіт «додав» із кнопкою відкату.
 * @param {{ title: string, date: string, start: string, end: string }} b
 */
export function calendarProposalText(b) {
  const [, m, d] = b.date.split('-');
  return `🗓 «${b.title}» ${d}.${m} ${b.start}-${b.end} - у календарі.`;
}

/**
 * Блоки плану в календар. Одна дія на блок, кожна зі своїм «↩»; збій одного
 * блока НЕ зупиняє решту - інакше одна відмова Google лишала б план
 * наполовину перенесеним і без жодного слова власнику.
 * @param {Env} env
 * @param {string} date
 * @param {{ id?: string, event_id?: string | null, title: string, est_min?: number | null, window_start: string | null, window_end: string | null, floating?: boolean | number | null }[]} rows
 * @param {number} nowMs
 * @param {{ chatId: number | string | null, threadId: number | string | null }} to
 * @param {(text: string, buttons: unknown) => Promise<void>} send
 * @param {boolean} [tainted] - позначка сесії, з якої прийшов plan.accept
 * @returns {Promise<{ added: number, proposed: number, failed: string[] }>}
 */
export async function calendarizeBlocks(env, date, rows, nowMs, to, send, tainted = false) {
  let added = 0;
  // ⚠️ Окремо від `added` (другий прохід ревʼю): без цього лічильника
  // результат «added 0, failed []» не відрізнити від «нічого не робив»,
  // хоча в чат уже пішли пропозиції з ✅ - і модель звітувала б «не переніс».
  let proposed = 0;
  /** @type {string[]} */
  const failed = [];
  for (const r of rows.filter((x) => x.window_start && x.window_end)) {
    // Повторний тап на «Затвердити» не створює той самий блок вдруге.
    if (r.event_id) continue;
    const startMs = kyivMs(date, String(r.window_start));
    const endMs = kyivMs(date, String(r.window_end));
    // ⚠️ Нерозібраний час - НЕ мовчазний пропуск (ревʼю релізу): блок просто
    // не поїхав би в календар, а модель звітувала б «переніс план». Тепер він
    // у `failed`, і про нього скажуть уголос.
    if (startMs == null || endMs == null) {
      failed.push(r.title);
      continue;
    }
    /** @type {Awaited<ReturnType<typeof applyPolicy>>} */
    let out;
    try {
      out = await applyPolicy(
        env,
        {
          kind: 'calendar.event',
          payload: {
            title: r.floating && r.est_min ? `${r.title} · ≈${r.est_min} хв у вікні` : r.title,
            startIso: new Date(startMs).toISOString(),
            endIso: new Date(endMs).toISOString(),
            transparent: Boolean(r.floating),
            silent: true,
          },
          threadId: to.threadId ?? null,
          chatId: to.chatId ?? null,
          // ⚠️ Позначка сесії йде НАСКРІЗЬ (security-ревʼю релізу). Доти тут
          // стояло жорстке false, і лист «закинь план у календар» клав чужі
          // назви в календар власника повз `calendar.event ∈ TAINT_ESCALATES`.
          tainted,
        },
        nowMs,
      );
    } catch (/** @type {any} */ e) {
      console.error(`plan: блок «${r.title}» у календар не пішов`, e?.message);
      failed.push(r.title);
      continue;
    }
    if (out.mode === 'error') {
      failed.push(r.title);
      continue;
    }
    // Рахуємо ЛИШЕ те, що справді сталось: пропозиція - ще не подія в
    // календарі, і звітувати про неї як про додану було б неправдою.
    if (out.mode === 'executed') {
      added += 1;
      const eventId =
        out.result && typeof out.result === 'object' && 'event_id' in out.result
          ? String(out.result.event_id ?? '')
          : '';
      if (r.id && eventId && env.DB) {
        await env.DB.prepare('UPDATE plan_items SET event_id = ? WHERE id = ? AND event_id IS NULL')
          .bind(eventId, r.id)
          .run();
      }
    } else proposed += 1;
    const block = {
      title: r.title,
      date,
      start: String(r.window_start),
      end: String(r.window_end),
    };
    // Кнопку шле ЯДРО: дію зробило воно, і без рядка в чаті власник не мав би
    // ані сліду, ані «↩» (приймання 05.09, B2).
    const buttons = out.mode === 'executed' ? (out.undo?.buttons ?? null) : out.proposal.buttons;
    await send(calendarProposalText(block), buttons);
  }
  return { added, proposed, failed };
}

/**
 * Рядок про блок у календарі з кнопкою («↩» для T0, ✅/❌ для події з гостями).
 * @param {Env} env
 * @param {{ chatId: number | string | null, threadId: number | string | null }} to
 * @param {string} text
 * @param {unknown} buttons
 * @param {number} nowMs
 */
export async function sendCalendarProposalRaw(env, to, text, buttons, nowMs) {
  if (to.chatId == null) {
    console.error('plan.accept: чат для рядка про календар невідомий');
    return;
  }
  const threadKey = to.threadId == null ? null : String(to.threadId);
  await enqueueOutbox(
    env,
    {
      chatId: to.chatId,
      threadId: threadKey == null || threadKey === 'dm' ? null : Number(threadKey),
      kind: 'send',
      payload: { text, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) => {
    console.error('plan.accept: драйн рядка про календар впав, доставить sweeper', e?.message);
  });
}
