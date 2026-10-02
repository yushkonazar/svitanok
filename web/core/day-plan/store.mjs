// План дня - сховище (07 §1 `day_plans`/`plan_items`, ADR-035, S-P-8…18):
// налаштування з facts, чернетка/прийняття/огляд дня, перенос пунктів,
// нагадування на початок блоків (T0), знімки для «↩». Розкладку рахує
// slots.mjs; ланцюг (chain.mjs) і plan.* інструменти кличуть лише це.

import { runFactsGet } from '../tools/facts.mjs';
import { runRemindersCreate, runRemindersCancel } from '../tools/reminders.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import {
  DAY_PLAN_DEFAULTS,
  HABIT_DEFAULTS,
  ITEM_KINDS,
  hhmmToMin,
  minToHhmm,
  parseWeekdays,
} from './slots.mjs';

/** Статуси дня - дослівно 07 §1. */
export const PLAN_STATUSES = ['intent', 'draft', 'accepted', 'reviewed', 'skipped'];
/** Захист від надмірного вводу; звичайні багатосправні дні не обрізаємо. */
export const ITEMS_MAX = 50;
/** Перенесений пункт живе 3 дні, далі «забути чи в ідеї?» (S-P-15). */
export const CARRY_MAX_DAYS = 3;
/** Мінімум символів, щоб префікс id рахувався посиланням на пункт (короткий
 *  або порожній ref інакше влучав би в перший-ліпший рядок). */
export const ID_PREFIX_MIN = 8;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - план дня недоступний');
  return env.DB;
}

/**
 * Налаштування плану дня (S-P-8 `facts.setting.day_plan`) + звички (S-P-6
 * `facts.habit.*`). Вимкнено, якщо факту немає або enabled=false.
 * @param {Env} env @param {number} [nowMs]
 */
export async function readDayPlanConfig(env, nowMs = Date.now()) {
  const [setting, habits] = await Promise.all([
    runFactsGet(env, { kind: 'setting', key: 'day_plan' }),
    runFactsGet(env, { kind: 'habit' }),
  ]);
  const raw = /** @type {Record<string, unknown>} */ (
    setting.result[0]?.value && typeof setting.result[0].value === 'object'
      ? setting.result[0].value
      : {}
  );
  const enabled = setting.result.length > 0 && raw.enabled !== false;
  /** @type {Record<string, unknown>} */
  const habitMap = {};
  for (const f of habits.result) habitMap[String(f.key)] = f.value;
  // Підказка, а не автоматична правка факту: тільки фактичні старти роботи
  // за різні дні останнього місяця. Медіана стійка до випадкового запізнення.
  const starts = await db(env)
    .prepare(
      `SELECT date, actual_started_at FROM plan_items
      WHERE role = 'work' AND actual_started_at IS NOT NULL AND date >= ?
      ORDER BY date DESC LIMIT 60`,
    )
    .bind(addDaysToDateKey(kyivDateKey(new Date(nowMs)), -30))
    .all();
  const perDay = new Map();
  for (const row of starts.results ?? []) {
    const day = String(row.date ?? '');
    const stamp = Date.parse(String(row.actual_started_at ?? ''));
    if (!day || !Number.isFinite(stamp)) continue;
    const minute = kyivMinuteOfDay(new Date(stamp));
    perDay.set(day, Math.min(perDay.get(day) ?? minute, minute));
  }
  const observed = [...perDay.values()].sort((a, b) => a - b);
  const learnedWorkStart =
    observed.length >= 5 ? minToHhmm(observed[Math.floor(observed.length / 2)]) : null;
  const settings = {
    intent_at: validHhmm(raw.intent_at) ?? DAY_PLAN_DEFAULTS.intent_at,
    morning_at: validHhmm(raw.morning_at) ?? DAY_PLAN_DEFAULTS.morning_at,
    review_at: validHhmm(raw.review_at) ?? DAY_PLAN_DEFAULTS.review_at,
    fill_ratio: Number(raw.fill_ratio) > 0 ? Number(raw.fill_ratio) : DAY_PLAN_DEFAULTS.fill_ratio,
    max_deep: Number.isInteger(Number(raw.max_deep))
      ? Number(raw.max_deep)
      : DAY_PLAN_DEFAULTS.max_deep,
    weekdays: typeof raw.weekdays === 'string' ? raw.weekdays : DAY_PLAN_DEFAULTS.weekdays,
  };
  return {
    enabled,
    settings,
    weekdays: parseWeekdays(settings.weekdays),
    habits: {
      day_start: validHhmm(habitMap.day_start) ?? HABIT_DEFAULTS.day_start,
      day_end: validHhmm(habitMap.day_end) ?? HABIT_DEFAULTS.day_end,
      lunch_at: validHhmm(habitMap.lunch_at) ?? HABIT_DEFAULTS.lunch_at,
      lunch_min: HABIT_DEFAULTS.lunch_min,
      estimate_bias:
        Number(habitMap.estimate_bias) > 0
          ? Number(habitMap.estimate_bias)
          : HABIT_DEFAULTS.estimate_bias,
      work_start_at: learnedWorkStart,
      work_start_samples: observed.length,
    },
  };
}

/** @param {unknown} v */
function validHhmm(v) {
  return hhmmToMin(v) == null ? null : String(v);
}

/**
 * @typedef {{ date: string, status: string, intent_text: string | null, fill_ratio: number | null,
 *   workflow_id: string | null, created_at: string, reviewed_at: string | null }} DayPlanRow
 * @typedef {{ id: string, date: string, title: string, kind: string | null, est_min: number | null,
 *   hard_at: string | null, hard_end: string | null, not_before: string | null, not_after: string | null,
 *   after_item_id: string | null, overlap_with_item_id: string | null, deadline: string | null,
 *   place: string | null, flexible: number | null, floating: number | null,
 *   optional: number | null, notify: number | null, role: string | null,
 *   priority: number | null, window_start: string | null, window_end: string | null, status: string,
 *   done_at: string | null, actual_started_at: string | null, reminder_id: string | null,
 *   event_id: string | null, calendar_sync_pending: number, calendar_sync_pending_at: string | null,
 *   calendar_sync_alerted_at: string | null, carried_from: string | null }} PlanItemRow
 */

/** @param {Env} env @param {string} date @returns {Promise<DayPlanRow | null>} */
export async function getDayPlan(env, date) {
  const row = await db(env).prepare('SELECT * FROM day_plans WHERE date = ?').bind(date).first();
  return /** @type {DayPlanRow | null} */ (row ?? null);
}

/**
 * Створити/оновити день. Статус звіряється зі списком; поля - лише відомі.
 * @param {Env} env
 * @param {string} date
 * @param {{ status?: string, intent_text?: string | null, fill_ratio?: number | null,
 *   workflow_id?: string | null, reviewed_at?: string | null }} patch
 * @param {number} nowMs
 */
export async function upsertDayPlan(env, date, patch, nowMs) {
  if (patch.status != null && !PLAN_STATUSES.includes(patch.status)) {
    throw new Error(`невідомий статус дня «${patch.status}»`);
  }
  const existing = await getDayPlan(env, date);
  const next = {
    status: patch.status ?? existing?.status ?? 'intent',
    intent_text:
      patch.intent_text !== undefined ? patch.intent_text : (existing?.intent_text ?? null),
    fill_ratio: patch.fill_ratio !== undefined ? patch.fill_ratio : (existing?.fill_ratio ?? null),
    workflow_id:
      patch.workflow_id !== undefined ? patch.workflow_id : (existing?.workflow_id ?? null),
    reviewed_at:
      patch.reviewed_at !== undefined ? patch.reviewed_at : (existing?.reviewed_at ?? null),
  };
  await db(env)
    .prepare(
      `INSERT INTO day_plans (date, status, intent_text, fill_ratio, workflow_id, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (date) DO UPDATE SET status = excluded.status, intent_text = excluded.intent_text,
         fill_ratio = excluded.fill_ratio, workflow_id = excluded.workflow_id, reviewed_at = excluded.reviewed_at`,
    )
    .bind(
      date,
      next.status,
      next.intent_text,
      next.fill_ratio,
      next.workflow_id,
      existing?.created_at ?? new Date(nowMs).toISOString(),
      next.reviewed_at,
    )
    .run();
  return { date, ...next, prev: existing };
}

/** @param {Env} env @param {string} date @returns {Promise<PlanItemRow[]>} */
export async function listItems(env, date) {
  const { results } = await db(env)
    .prepare('SELECT * FROM plan_items WHERE date = ? ORDER BY window_start, priority, title')
    .bind(date)
    .all();
  return /** @type {PlanItemRow[]} */ (results ?? []);
}

/**
 * Нормалізувати пункт наміру (від працівника або з plan.intent): kind зі
 * списку, title ≤ 60, est_min ≥ 5 або null, часові межі «HH:MM» або null.
 * @param {Record<string, unknown>} raw
 * @param {number} index
 */
export function normalizeItem(raw, index) {
  const title = String(raw.title ?? '')
    .trim()
    .slice(0, 60);
  if (!title) throw new Error(`пункт ${index + 1}: порожня назва`);
  const kind = ITEM_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'routine';
  const est = Number(raw.est_min);
  const hard = hhmmToMin(raw.hard_at) == null ? null : String(raw.hard_at);
  const hardEnd = hhmmToMin(raw.hard_end) == null ? null : String(raw.hard_end);
  const notBefore = hhmmToMin(raw.not_before) == null ? null : String(raw.not_before);
  const notAfter = hhmmToMin(raw.not_after) == null ? null : String(raw.not_after);
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.deadline ?? ''))
    ? String(raw.deadline)
    : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    title,
    kind,
    est_min: Number.isFinite(est) && est >= 5 ? Math.round(est) : null,
    hard_at: hard,
    hard_end: hardEnd,
    not_before: notBefore,
    not_after: notAfter,
    after_item_id: typeof raw.after_item_id === 'string' ? raw.after_item_id : null,
    overlap_with_item_id:
      typeof raw.overlap_with_item_id === 'string' ? raw.overlap_with_item_id : null,
    deadline,
    place: raw.place == null ? null : String(raw.place).slice(0, 120),
    flexible: raw.flexible === true || raw.flexible === 1,
    floating: raw.floating === true || raw.floating === 1,
    optional: raw.optional === true || raw.optional === 1,
    notify: raw.notify === true || raw.notify === 1,
    role: ['work', 'meal'].includes(String(raw.role)) ? String(raw.role) : null,
    priority:
      raw.priority != null && Number.isInteger(Number(raw.priority))
        ? Number(raw.priority)
        : index + 1,
    carried_from: typeof raw.carried_from === 'string' ? raw.carried_from : null,
  };
}

/** Resolve a model's local `after` index only against the same submitted list.
 * IDs supplied by the model are ignored, including dependency IDs.
 * @param {Record<string, unknown>[]} raw
 */
export function normalizePlanItems(raw) {
  const items = raw.map((r, index) =>
    normalizeItem(
      { ...r, id: undefined, after_item_id: undefined, overlap_with_item_id: undefined },
      index,
    ),
  );
  for (let index = 0; index < raw.length; index += 1) {
    const reference = raw[index]?.after;
    const predecessor = typeof reference === 'number' ? reference : Number.NaN;
    if (Number.isInteger(predecessor) && predecessor >= 0 && predecessor < index) {
      const item = items[index];
      const previous = items[predecessor];
      if (item && previous) item.after_item_id = previous.id;
    }
    const parallel = raw[index]?.parallel_with;
    const parent = typeof parallel === 'number' ? parallel : Number.NaN;
    if (Number.isInteger(parent) && parent >= 0 && parent < raw.length && parent !== index) {
      const item = items[index];
      const enclosing = items[parent];
      if (item && enclosing) item.overlap_with_item_id = enclosing.id;
    }
  }
  return items;
}

/**
 * Замінити пункти дня розкладкою (чернетка): planned без нагадувань.
 * Пункти з reminder_id (уже прийняті) не чіпаються - нагадування живуть.
 * @param {Env} env
 * @param {string} date
 * @param {{ placed: any[], flexible: any[] }} slots
 * @param {ReturnType<typeof normalizeItem>[]} items
 */
export async function replaceItems(env, date, slots, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  // est_min у рядку - СИРА оцінка власника/моделі (для «оцінка проти факту»
  // у тижневому звіті і щоб plan.draft не множив запас удруге); довжина
  // блоку з запасом живе у window_start/window_end.
  const rows = [
    ...slots.placed.map((p) => ({
      ...byId.get(p.id),
      ...p,
      est_min: byId.get(p.id)?.est_min ?? null,
      flexible: 0,
    })),
    ...slots.flexible.map((f) => ({
      ...byId.get(f.id),
      ...f,
      window_start: null,
      window_end: null,
      flexible: 1,
    })),
  ];
  const d = db(env);
  const stmts = [
    d.prepare(`DELETE FROM plan_items WHERE date = ? AND reminder_id IS NULL`).bind(date),
  ];
  for (const r of rows) {
    stmts.push(
      d
        .prepare(
          `INSERT OR REPLACE INTO plan_items (id, date, title, kind, est_min, hard_at, hard_end, not_before, not_after,
             after_item_id, overlap_with_item_id, deadline, place, flexible, floating, optional, notify,
             role, priority, window_start, window_end, status, carried_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
        )
        .bind(
          r.id,
          date,
          r.title,
          r.kind ?? null,
          r.est_min ?? null,
          r.hard_at ?? null,
          r.hard_end ?? null,
          r.not_before ?? null,
          r.not_after ?? null,
          r.after_item_id ?? null,
          r.overlap_with_item_id ?? null,
          r.deadline ?? null,
          r.place ?? null,
          r.flexible ? 1 : 0,
          r.floating ? 1 : 0,
          r.optional ? 1 : 0,
          r.notify ? 1 : 0,
          r.role ?? null,
          r.priority ?? null,
          r.window_start ?? null,
          r.window_end ?? null,
          r.carried_from ?? null,
        ),
    );
  }
  await d.batch(stmts);
  return rows.length;
}

/**
 * Прийняти план (S-P-12): статус accepted + нагадування на початок кожного
 * блоку з часом (T0). Нагадування адресуються в тему «Асистент» (address =
 * чат/тред плану). Повертає знімок для «↩»: id створених нагадувань.
 * @param {Env} env
 * @param {string} date
 * @param {number} nowMs
 * @param {{ chatId: number | string | null, threadId: number | string | null }} address
 */
export async function acceptPlan(env, date, nowMs, address) {
  const items = await listItems(env, date);
  const d = db(env);
  /** @type {string[]} */
  const reminderIds = [];
  const stmts = [];
  for (const it of items) {
    if (!it.window_start || it.reminder_id || !it.notify) continue;
    const dueAtMs = kyivMs(date, it.window_start);
    if (dueAtMs == null || dueAtMs <= nowMs) continue;
    // Послідовно: кожне створення повертає id, потрібний для UPDATE нижче.
    const { result } = await runRemindersCreate(env, { text: `План: ${it.title}` }, nowMs, {
      dueAtMs,
      chatId: address.chatId,
      threadId: address.threadId,
    });
    reminderIds.push(result.id);
    it.reminder_id = result.id;
    stmts.push(
      d.prepare('UPDATE plan_items SET reminder_id = ? WHERE id = ?').bind(result.id, it.id),
    );
  }
  if (stmts.length) await d.batch(stmts);
  await upsertDayPlan(env, date, { status: 'accepted' }, nowMs);
  return { date, reminders: reminderIds.length, reminderIds, items };
}

/**
 * Відкат прийняття: скасувати ЛИШЕ нагадування з цього знімку і відвʼязати
 * лише їх (інші пункти дати могли бути прийняті раніше - їхні нагадування
 * живі), статус назад у draft. Збій скасування - у лог, відкат триває.
 * @param {Env} env @param {{ date: string, reminderIds: string[] }} snapshot @param {number} nowMs
 */
export async function undoAccept(env, snapshot, nowMs) {
  const d = db(env);
  for (const id of snapshot.reminderIds) {
    await runRemindersCancel(env, { id }).catch((/** @type {any} */ e) => {
      console.error(`day-plan: нагадування ${id} не скасовано при «↩»`, e?.message);
    });
  }
  if (snapshot.reminderIds.length) {
    await d.batch(
      snapshot.reminderIds.map((id) =>
        d.prepare('UPDATE plan_items SET reminder_id = NULL WHERE reminder_id = ?').bind(id),
      ),
    );
  }
  await upsertDayPlan(env, snapshot.date, { status: 'draft' }, nowMs);
}

/** День переглянуто без переносу (S-P-15 «Ні»/усе закрито). @param {Env} env @param {string} date @param {number} nowMs */
export async function markReviewed(env, date, nowMs) {
  await upsertDayPlan(
    env,
    date,
    { status: 'reviewed', reviewed_at: new Date(nowMs).toISOString() },
    nowMs,
  );
}

/**
 * Пункт за посиланням: точний id → префікс id (≥ ID_PREFIX_MIN) → назва без
 * регістру. Спільний для updateItems і plan.review.
 * @template {{ id: string, title: string }} T
 * @param {T[]} items @param {string} ref @param {string} where - для тексту помилки
 * @returns {T}
 */
export function resolveItemRef(items, ref, where) {
  const hit =
    items.find((i) => i.id === ref) ??
    items.find(
      (i) =>
        (ref.length >= ID_PREFIX_MIN && i.id.startsWith(ref)) ||
        i.title.toLowerCase() === ref.toLowerCase(),
    );
  if (!hit) throw new Error(`пункту «${ref}» ${where} немає`);
  return hit;
}

/**
 * Зміни вдень (S-P-14): done[] - позначити зробленим (done_at = зараз),
 * starts[] - фактичний початок ({id, at?:'HH:MM'}), moves[] - новий час
 * блоку ({id, to:'HH:MM'}), drop[] - пропустити.
 * Повертає знімок попередніх станів для «↩».
 * @param {Env} env
 * @param {string} date
 * @param {{ starts?: { id: string, at?: string }[], done?: string[], moves?: { id: string, to: string }[], drop?: string[] }} changes
 * @param {number} nowMs
 */
export async function updateItems(env, date, changes, nowMs, calendarSynced = false) {
  const items = await listItems(env, date);
  const resolve = (/** @type {string} */ ref) => resolveItemRef(items, ref, `у плані ${date}`);
  /** @type {(ReturnType<typeof snapshot> & { reminder?: { id: string, status: string, due_at: string } | null })[]} */
  const prev = [];
  const iso = new Date(nowMs).toISOString();
  const d = db(env);
  const stmts = [];
  for (const start of changes.starts ?? []) {
    const it = resolve(start.id);
    if (start.at == null && date !== kyivDateKey(new Date(nowMs)))
      throw new Error('для іншого дня вкажи фактичний час початку HH:MM');
    const atMs = start.at == null ? nowMs : kyivMs(date, start.at);
    if (atMs == null || !Number.isFinite(atMs))
      throw new Error(`час початку «${start.at}» - очікую HH:MM`);
    if (atMs > nowMs + 60_000) throw new Error('фактичний початок не може бути в майбутньому');
    const before = snapshot(it);
    prev.push(before);
    stmts.push(
      d
        .prepare('UPDATE plan_items SET actual_started_at = ? WHERE id = ?')
        .bind(new Date(atMs).toISOString(), it.id),
    );
  }
  for (const ref of changes.done ?? []) {
    const it = resolve(ref);
    prev.push(snapshot(it));
    stmts.push(
      d.prepare(`UPDATE plan_items SET status = 'done', done_at = ? WHERE id = ?`).bind(iso, it.id),
    );
  }
  for (const mv of changes.moves ?? []) {
    const it = resolve(mv.id);
    if (it.event_id && !calendarSynced)
      throw new Error(
        `«${it.title}» уже в календарі. Не зсуваю лише локальний план без зміни події.`,
      );
    const start = hhmmToMin(mv.to);
    if (start == null) throw new Error(`час «${mv.to}» - очікую HH:MM`);
    // Довжина блоку - з наявного вікна; без вікна - оцінка або 30 хв.
    // Опубліковану подію не обрізаємо мовчки на межі дня.
    const ws = hhmmToMin(it.window_start);
    const we = hhmmToMin(it.window_end);
    const len = ws != null && we != null && we > ws ? we - ws : (it.est_min ?? 30);
    if (it.event_id && start + len >= 24 * 60)
      throw new Error(`«${it.title}» не вміщується в цей день — обери раніший час`);
    /** @type {ReturnType<typeof snapshot> & { reminder?: { id: string, status: string, due_at: string } | null }} */
    const before = snapshot(it);
    prev.push(before);
    stmts.push(
      d
        .prepare(
          `UPDATE plan_items SET window_start = ?, window_end = ?, hard_at = ?, hard_end = NULL, not_before = NULL, flexible = 0, calendar_sync_pending = ?, calendar_sync_pending_at = ?, calendar_sync_alerted_at = NULL WHERE id = ?`,
        )
        .bind(
          minToHhmm(start),
          minToHhmm(start + len),
          minToHhmm(start),
          calendarSynced && it.event_id ? 1 : 0,
          calendarSynced && it.event_id ? iso : null,
          it.id,
        ),
    );
    if (it.reminder_id) {
      const reminder = await d
        .prepare('SELECT status, due_at FROM reminders WHERE id = ?')
        .bind(it.reminder_id)
        .first();
      before.reminder = reminder
        ? { id: it.reminder_id, status: String(reminder.status), due_at: String(reminder.due_at) }
        : null;
      if (reminder && ['pending', 'snoozed'].includes(String(reminder.status))) {
        const dueAt = kyivMs(date, minToHhmm(start));
        if (dueAt == null) throw new Error(`час «${mv.to}» не вдалося визначити`);
        stmts.push(
          d
            .prepare(
              `UPDATE reminders SET due_at = ?, status = ? WHERE id = ? AND status IN ('pending', 'snoozed')`,
            )
            .bind(
              new Date(dueAt).toISOString(),
              dueAt > nowMs ? 'pending' : 'cancelled',
              it.reminder_id,
            ),
        );
      }
    }
  }
  for (const ref of changes.drop ?? []) {
    const it = resolve(ref);
    if (it.event_id && !calendarSynced)
      throw new Error(
        `«${it.title}» уже в календарі. Не прибираю лише локальний план без зміни події.`,
      );
    /** @type {ReturnType<typeof snapshot> & { reminder?: { id: string, status: string, due_at: string } | null }} */
    const before = snapshot(it);
    prev.push(before);
    stmts.push(
      d
        .prepare(
          `UPDATE plan_items SET status = 'skipped', event_id = ?, reminder_id = NULL, calendar_sync_pending = ?, calendar_sync_pending_at = ?, calendar_sync_alerted_at = NULL WHERE id = ?`,
        )
        .bind(
          calendarSynced ? it.event_id : null,
          calendarSynced && it.event_id ? 1 : 0,
          calendarSynced && it.event_id ? iso : null,
          it.id,
        ),
    );
    if (it.reminder_id) {
      const reminder = await d
        .prepare('SELECT status, due_at FROM reminders WHERE id = ?')
        .bind(it.reminder_id)
        .first();
      before.reminder = reminder
        ? { id: it.reminder_id, status: String(reminder.status), due_at: String(reminder.due_at) }
        : null;
      if (reminder && ['pending', 'snoozed'].includes(String(reminder.status)))
        stmts.push(
          d
            .prepare(
              `UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'snoozed')`,
            )
            .bind(it.reminder_id),
        );
    }
  }
  if (stmts.length === 0) throw new Error('нічого змінювати');
  await d.batch(stmts);
  return { date, changed: prev.length, prev };
}

/** Відкат updateItems. @param {Env} env @param {{ prev: any[] }} snap */
export async function undoUpdateItems(env, snap) {
  const d = db(env);
  await d.batch([
    ...snap.prev.map((p) => {
      const old = [
        p.status,
        p.done_at,
        p.actual_started_at,
        p.window_start,
        p.window_end,
        p.hard_at,
        p.hard_end,
        p.not_before,
        p.flexible,
      ];
      // Undo cards created before this release have no event/reminder IDs in
      // their snapshots. Preserve the current links instead of clearing them.
      return 'event_id' in p
        ? d
            .prepare(
              `UPDATE plan_items SET status = ?, done_at = ?, actual_started_at = ?, window_start = ?, window_end = ?, hard_at = ?, hard_end = ?, not_before = ?, flexible = ?, event_id = ?, reminder_id = ?, calendar_sync_pending = ?, calendar_sync_pending_at = ?, calendar_sync_alerted_at = ? WHERE id = ?`,
            )
            .bind(
              ...old,
              p.event_id,
              p.reminder_id,
              p.calendar_sync_pending ?? 0,
              p.calendar_sync_pending_at ?? null,
              p.calendar_sync_alerted_at ?? null,
              p.id,
            )
        : d
            .prepare(
              `UPDATE plan_items SET status = ?, done_at = ?, actual_started_at = ?, window_start = ?, window_end = ?, hard_at = ?, hard_end = ?, not_before = ?, flexible = ? WHERE id = ?`,
            )
            .bind(...old, p.id);
    }),
    ...snap.prev
      .filter((p) => p.reminder)
      .map((p) =>
        d
          .prepare('UPDATE reminders SET status = ?, due_at = ? WHERE id = ?')
          .bind(p.reminder.status, p.reminder.due_at, p.reminder.id),
      ),
  ]);
}

/**
 * Огляд дня (S-P-15): зроблено/заплановано, кандидати на перенос.
 * @param {Env} env @param {string} date
 */
export async function reviewPlan(env, date) {
  const items = await listItems(env, date);
  const done = items.filter((i) => i.status === 'done');
  const open = items.filter((i) => i.status === 'planned');
  return {
    date,
    planned: items.filter((i) => i.status !== 'skipped').length,
    done: done.length,
    open: open.map((i) => ({ id: i.id, title: i.title, carried_from: i.carried_from })),
  };
}

/**
 * Перенести пункти на дату (S-P-15): старі → carried, нові → planned на
 * to з carried_from = початкова дата (щоб рахувати «третій день поспіль»).
 * @param {Env} env
 * @param {string} from
 * @param {string} to
 * @param {string[]} ids - порожньо = усі відкриті
 * @param {number} nowMs
 */
export async function carryItems(env, from, to, ids, nowMs) {
  const items = (await listItems(env, from)).filter((i) => i.status === 'planned');
  const chosen = ids.length ? items.filter((i) => ids.includes(i.id)) : items;
  const d = db(env);
  const stmts = [];
  /** @type {{ title: string, origin: string, days: number }[]} */
  const carried = [];
  for (const it of chosen) {
    const origin = it.carried_from ?? from;
    const days = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${origin}T00:00:00Z`)) / 86_400_000,
    );
    carried.push({ title: it.title, origin, days });
    stmts.push(d.prepare(`UPDATE plan_items SET status = 'carried' WHERE id = ?`).bind(it.id));
    stmts.push(
      d
        .prepare(
          `INSERT INTO plan_items (id, date, title, kind, est_min, hard_at, hard_end, not_before, deadline, place, flexible, priority, status, carried_from, role, optional, notify)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 1, ?, 'planned', ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          to,
          it.title,
          it.kind,
          it.est_min,
          it.deadline,
          it.place,
          it.priority,
          origin,
          it.role,
          it.optional ?? 0,
          it.notify ?? 0,
        ),
    );
  }
  if (stmts.length) await d.batch(stmts);
  await upsertDayPlan(
    env,
    from,
    { status: 'reviewed', reviewed_at: new Date(nowMs).toISOString() },
    nowMs,
  );
  return { carried, stale: carried.filter((c) => c.days >= CARRY_MAX_DAYS) };
}

/** Пункти на дату, перенесені з попередніх днів, - вхід для розкладки. @param {Env} env @param {string} date */
export async function carriedInto(env, date) {
  return (await listItems(env, date)).filter((i) => i.carried_from && i.status === 'planned');
}

/** Наступний робочий день за налаштуванням weekdays. @param {string} date @param {Set<number>} weekdays */
export function nextPlannedDay(date, weekdays) {
  let d = date;
  for (let i = 0; i < 8; i += 1) {
    d = addDaysToDateKey(d, 1);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (weekdays.has(dow === 0 ? 7 : dow)) return d;
  }
  return addDaysToDateKey(date, 1);
}

/** @param {PlanItemRow} it */
function snapshot(it) {
  return {
    id: it.id,
    status: it.status,
    done_at: it.done_at,
    actual_started_at: it.actual_started_at,
    window_start: it.window_start,
    window_end: it.window_end,
    hard_at: it.hard_at,
    hard_end: it.hard_end,
    not_before: it.not_before,
    flexible: it.flexible,
    event_id: it.event_id,
    reminder_id: it.reminder_id,
    calendar_sync_pending: it.calendar_sync_pending,
    calendar_sync_pending_at: it.calendar_sync_pending_at,
    calendar_sync_alerted_at: it.calendar_sync_alerted_at,
  };
}

/**
 * Київський момент дати+часу в мс (літній/зимовий зсув - через Intl).
 * @param {string} date @param {string} hhmmStr
 */
export function kyivMs(date, hhmmStr) {
  const min = hhmmToMin(hhmmStr);
  if (min == null) return null;
  const guess = Date.parse(`${date}T${hhmmStr.padStart(5, '0')}:00Z`);
  // Зсув Києва для цієї дати: різниця між «як Київ показує guess» і UTC.
  let offset = kyivMinuteOfDay(new Date(guess)) - min;
  if (offset > 12 * 60) offset -= 24 * 60;
  if (offset < -12 * 60) offset += 24 * 60;
  return guess - offset * 60_000;
}
