// plan.* (07 §4, ADR-035, S-P-14): інструменти плану дня для чату - T0 з
// «↩» для accept. Розкладку рахує ядро (slots.mjs), сховище - store.mjs;
// тут лише контракт аргументів, читання календаря/енергії й знімки для undo.
//   plan.intent  {date?, items[]}        - пункти → розкладка → чернетка
//   plan.draft   {date}                  - перерахувати чернетку з наявних пунктів
//   plan.accept  {date, calendar?}       - прийняти (нагадування; календар - T1)
//   plan.update  {date, done[], moves[], drop[]} - зміни вдень
//   plan.review  {date, carry[]}          - огляд і перенос (["all"] - усі відкриті)

import { readCalendarRange } from '../../google.mjs';
import { loadStats } from '../../kv-store.mjs';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { applyPolicy } from '../policy/proposals.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';
import { computeSlots, formatDraft, energyBySlot } from './../day-plan/slots.mjs';
import {
  readDayPlanConfig,
  getDayPlan,
  listItems,
  normalizeItem,
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
  const config = await readDayPlanConfig(env);
  const [calendar, stats] = await Promise.all([readCalendarRange(env, date, date), loadStats(env)]);
  if (calendar == null)
    throw new Error('календар недоступний (токен або мережа) - без нього розкладка сліпа');
  const events = calendar.map((e) => ({
    title: String(e.title ?? ''),
    startMin: typeof e.startMs === 'number' ? kyivMinuteOfDay(new Date(e.startMs)) : null,
    endMin: typeof e.endMs === 'number' ? kyivMinuteOfDay(new Date(e.endMs)) : null,
  }));
  const slots = computeSlots({
    date,
    items: items.slice(0, ITEMS_MAX),
    events,
    settings: config.settings,
    habits: config.habits,
    energy: energyBySlot(stats.checkins ?? {}),
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
  if (!Array.isArray(args.items) || args.items.length === 0)
    throw new Error('items - непорожній список пунктів');
  // id від моделі не приймаємо (те саме, що normalizeIntent у ланцюзі):
  // replaceItems робить INSERT OR REPLACE за глобальним id, і чужий id
  // перетягнув би рядок іншої дати разом із reminder_id.
  const items = args.items
    .slice(0, ITEMS_MAX)
    .map((r, i) =>
      normalizeItem({ .../** @type {Record<string, unknown>} */ (r ?? {}), id: undefined }, i),
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
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} [ctx]
 */
export async function runPlanAccept(env, args, nowMs, ctx = {}) {
  const date = resolvePlanDate(args.date, nowMs);
  const plan = await getDayPlan(env, date);
  if (!plan) throw new Error(`на ${date} немає чернетки - спершу plan.intent`);
  // Адреса як у collection.export: chat прогону, а без нього - DM власника
  // для треду 'dm' і група для теми (ревʼю 05.09: група замість DM - помилка).
  const threadKey = ctx.threadId == null ? null : String(ctx.threadId);
  const isDm = threadKey === 'dm';
  const chatId =
    ctx.chatId ?? (isDm ? (env.TELEGRAM_OWNER_USER_ID ?? null) : (env.TELEGRAM_CHAT_ID ?? null));
  const res = await acceptPlan(env, date, nowMs, {
    chatId,
    threadId: ctx.threadId ?? env.TOPIC_ASSISTANT ?? null,
  });
  /** @type {string[]} */
  const proposals = [];
  if (args.calendar === true) {
    for (const r of res.items.filter((x) => x.window_start && x.window_end)) {
      const startMs = kyivMs(date, String(r.window_start));
      const endMs = kyivMs(date, String(r.window_end));
      if (startMs == null || endMs == null) continue;
      const out = await applyPolicy(
        env,
        {
          kind: 'calendar.event',
          payload: {
            title: r.title,
            startIso: new Date(startMs).toISOString(),
            endIso: new Date(endMs).toISOString(),
          },
          threadId: ctx.threadId ?? null,
          tainted: false,
        },
        nowMs,
      );
      if (out.mode !== 'proposed') continue;
      proposals.push(out.proposal.id);
      // Пропозицію створило ядро, не модель - кнопки ✅/❌ шле теж ядро, інакше
      // вона лежить open без сліду в чаті (приймання 05.09, B2).
      await sendCalendarProposal(
        env,
        { chatId, threadId: ctx.threadId ?? null },
        { title: r.title, date, start: String(r.window_start), end: String(r.window_end) },
        out.proposal.buttons,
        nowMs,
      );
    }
  }
  return {
    result: { date, status: 'accepted', reminders: res.reminders, calendar_proposals: proposals },
    prev: { date, reminderIds: res.reminderIds, status: plan.status },
  };
}

/** Відкат accept. @param {Env} env @param {{ date: string, reminderIds: string[] }} snap @param {number} nowMs */
export async function undoPlanAccept(env, snap, nowMs) {
  await undoAccept(env, snap, nowMs);
}

/**
 * plan.update (T0 з «↩»): «X зроблено», «зсунь Y на 16», «забери Z».
 * @param {Env} env
 * @param {{ date?: string, done?: string[], moves?: { id: string, to: string }[], drop?: string[] }} args
 * @param {number} nowMs
 */
export async function runPlanUpdate(env, args, nowMs) {
  const date = resolvePlanDate(args.date, nowMs);
  const out = await updateItems(
    env,
    date,
    { done: args.done ?? [], moves: args.moves ?? [], drop: args.drop ?? [] },
    nowMs,
  );
  return { result: { date, changed: out.changed }, prev: { date, prev: out.prev } };
}

/** Відкат update. @param {Env} env @param {{ prev: any[] }} snap */
export async function undoPlanUpdate(env, snap) {
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
 * Текст пропозиції «блок у календар» - спільний для plan.accept і ланцюга.
 * @param {{ title: string, date: string, start: string, end: string }} b
 */
export function calendarProposalText(b) {
  const [, m, d] = b.date.split('-');
  return `🗓 «${b.title}» ${d}.${m} ${b.start}-${b.end} - додати в календар?`;
}

/**
 * Надіслати пропозицію з кнопками в тред (T1 виконавець календаря - етап 7,
 * до того після ✅ буде чесне «виконавця ще немає»).
 * @param {Env} env
 * @param {{ chatId: number | string | null, threadId: number | string | null }} to
 * @param {{ title: string, date: string, start: string, end: string }} block
 * @param {unknown} buttons
 * @param {number} nowMs
 */
async function sendCalendarProposal(env, to, block, buttons, nowMs) {
  if (to.chatId == null) {
    console.error('plan.accept: чат для пропозиції календаря невідомий');
    return;
  }
  const threadKey = to.threadId == null ? null : String(to.threadId);
  await enqueueOutbox(
    env,
    {
      chatId: to.chatId,
      threadId: threadKey == null || threadKey === 'dm' ? null : Number(threadKey),
      kind: 'send',
      payload: { text: calendarProposalText(block), reply_markup: { inline_keyboard: buttons } },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) => {
    console.error('plan.accept: драйн пропозиції календаря впав, доставить sweeper', e?.message);
  });
}
