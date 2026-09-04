// План дня - сховище (07 §1 `day_plans`/`plan_items`, ADR-035, S-P-8…18):
// налаштування з facts, чернетка/прийняття/огляд дня, перенос пунктів,
// нагадування на початок блоків (T0), знімки для «↩». Розкладку рахує
// slots.mjs; ланцюг (chain.mjs) і plan.* інструменти кличуть лише це.

import { runFactsGet } from '../tools/facts.mjs';
import { runRemindersCreate, runRemindersCancel } from '../tools/reminders.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { kyivMinuteOfDay } from '../../kyiv-time.mjs';
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
/** Стеля пунктів на день (день-planner.md: «понад 6 - лиши 6»). */
export const ITEMS_MAX = 6;
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
 * @param {Env} env
 */
export async function readDayPlanConfig(env) {
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
 *   hard_at: string | null, deadline: string | null, place: string | null, flexible: number | null,
 *   priority: number | null, window_start: string | null, window_end: string | null, status: string,
 *   done_at: string | null, reminder_id: string | null, event_id: string | null, carried_from: string | null }} PlanItemRow
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
 * списку, title ≤ 60, est_min ≥ 5 або null, hard_at «HH:MM» або null.
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
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.deadline ?? ''))
    ? String(raw.deadline)
    : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    title,
    kind,
    est_min: Number.isFinite(est) && est >= 5 ? Math.round(est) : null,
    hard_at: hard,
    deadline,
    place: raw.place == null ? null : String(raw.place).slice(0, 120),
    flexible: raw.flexible === true,
    priority: Number.isInteger(Number(raw.priority)) ? Number(raw.priority) : index + 1,
    carried_from: typeof raw.carried_from === 'string' ? raw.carried_from : null,
  };
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
          `INSERT OR REPLACE INTO plan_items (id, date, title, kind, est_min, hard_at, deadline, place, flexible,
             priority, window_start, window_end, status, carried_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
        )
        .bind(
          r.id,
          date,
          r.title,
          r.kind ?? null,
          r.est_min ?? null,
          r.hard_at ?? null,
          r.deadline ?? null,
          r.place ?? null,
          r.flexible ? 1 : 0,
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
    if (!it.window_start || it.reminder_id) continue;
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
 * moves[] - новий час блоку ({id, to:'HH:MM'}), drop[] - пропустити.
 * Повертає знімок попередніх станів для «↩».
 * @param {Env} env
 * @param {string} date
 * @param {{ done?: string[], moves?: { id: string, to: string }[], drop?: string[] }} changes
 * @param {number} nowMs
 */
export async function updateItems(env, date, changes, nowMs) {
  const items = await listItems(env, date);
  const resolve = (/** @type {string} */ ref) => resolveItemRef(items, ref, `у плані ${date}`);
  /** @type {{ id: string, status: string, done_at: string | null, window_start: string | null, window_end: string | null }[]} */
  const prev = [];
  const iso = new Date(nowMs).toISOString();
  const d = db(env);
  const stmts = [];
  for (const ref of changes.done ?? []) {
    const it = resolve(ref);
    prev.push(snapshot(it));
    stmts.push(
      d.prepare(`UPDATE plan_items SET status = 'done', done_at = ? WHERE id = ?`).bind(iso, it.id),
    );
  }
  for (const mv of changes.moves ?? []) {
    const it = resolve(mv.id);
    const start = hhmmToMin(mv.to);
    if (start == null) throw new Error(`час «${mv.to}» - очікую HH:MM`);
    // Довжина блоку - з наявного вікна (уже з запасом); без вікна - сира
    // оцінка або 30 хв. Кінець клемпиться до 23:59 (minToHhmm).
    const ws = hhmmToMin(it.window_start);
    const we = hhmmToMin(it.window_end);
    const len = ws != null && we != null && we > ws ? we - ws : (it.est_min ?? 30);
    prev.push(snapshot(it));
    stmts.push(
      d
        .prepare(
          `UPDATE plan_items SET window_start = ?, window_end = ?, flexible = 0 WHERE id = ?`,
        )
        .bind(minToHhmm(start), minToHhmm(start + len), it.id),
    );
  }
  for (const ref of changes.drop ?? []) {
    const it = resolve(ref);
    prev.push(snapshot(it));
    stmts.push(d.prepare(`UPDATE plan_items SET status = 'skipped' WHERE id = ?`).bind(it.id));
  }
  if (stmts.length === 0) throw new Error('нічого змінювати');
  await d.batch(stmts);
  return { date, changed: prev.length, prev };
}

/** Відкат updateItems. @param {Env} env @param {{ prev: any[] }} snap */
export async function undoUpdateItems(env, snap) {
  const d = db(env);
  await d.batch(
    snap.prev.map((p) =>
      d
        .prepare(
          `UPDATE plan_items SET status = ?, done_at = ?, window_start = ?, window_end = ? WHERE id = ?`,
        )
        .bind(p.status, p.done_at, p.window_start, p.window_end, p.id),
    ),
  );
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
          `INSERT INTO plan_items (id, date, title, kind, est_min, hard_at, deadline, place, flexible, priority, status, carried_from)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, 'planned', ?)`,
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
    window_start: it.window_start,
    window_end: it.window_end,
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
