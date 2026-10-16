import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';

export const PLAN_OPERATIONS = [
  'settings',
  'task-save',
  'task-delete',
  'accept',
  'report',
  'undo-report',
  'start',
  'move-start',
  'snooze',
  'exception',
  'forfeit',
  'recommit',
  'goal-save',
  'reward-save',
  'reward-archive',
  'redeem',
  'coupon-use',
  'coupon-refund',
  'shift-open',
  'shift-close',
];
export const XP_BANDS = [10, 20, 35, 50];
export const DEFAULT_PLAN_SETTINGS = {
  enabled: false,
  reviewedAt: /** @type {string | null} */ (null),
  penaltyPercent: 30,
  dayBoundary: '04:00',
  reportGraceHours: 12,
  eveningAt: '20:30',
};
export const REWARD_SUGGESTIONS = [
  { title: 'Особливий напій із десертом', price: 80, scale: 'near' },
  { title: 'Вечір кіно зі смаколиками', price: 100, scale: 'near' },
  { title: 'Книга для задоволення', price: 150, scale: 'near' },
  { title: 'Бажана гра або розважальний контент', price: 300, scale: 'middle' },
  { title: 'Вечеря удвох', price: 450, scale: 'middle' },
  { title: 'Квитки на обрану подію', price: 500, scale: 'middle' },
  { title: 'Річ для хобі чи комфорту', price: 600, scale: 'middle' },
  { title: 'Одноденна поїздка', price: 1200, scale: 'large' },
  { title: 'Бажана велика покупка', price: 2000, scale: 'large' },
  { title: 'Apple Watch', price: 2500, scale: 'large' },
];

export class PlanError extends Error {
  constructor(message = 'Перевір дані.', status = 400) {
    super(message);
    this.name = 'PlanError';
    this.status = status;
  }
}

/** @typedef {{revision:number,balance:number,experience:number,settings:typeof DEFAULT_PLAN_SETTINGS,primaryRewardId:string|null,records:Record<string,any>}} PlanState */
/** @returns {PlanState} */
export function emptyPlan() {
  return {
    revision: 0,
    balance: 0,
    experience: 0,
    settings: { ...DEFAULT_PLAN_SETTINGS },
    primaryRewardId: null,
    records: {},
  };
}
/** @param {unknown} raw @param {number} max @param {boolean} [required] */
function text(raw, max, required = false) {
  if (raw != null && typeof raw !== 'string') throw new PlanError('Очікується текст.');
  const value = String(raw ?? '').trim();
  if (value.length > max || (required && !value))
    throw new PlanError(`Заповни текст (до ${max} символів).`);
  return value;
}
/** @param {unknown} raw @param {number} min @param {number} max */
function integer(raw, min, max) {
  if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max)
    throw new PlanError(`Укажи ціле число від ${min} до ${max}.`);
  return Number(raw);
}
/** @param {unknown} raw */
export function planDate(raw) {
  const s = text(raw, 10, true);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) !== s
  )
    throw new PlanError('Перевір дату.');
  return s;
}
/** @param {unknown} raw */
function clock(raw) {
  const s = text(raw, 5, true);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new PlanError('Час має бути у форматі ГГ:ХХ.');
  return s;
}
/** @param {unknown} raw */
function iso(raw) {
  const s = text(raw, 40, true);
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s)))
    throw new PlanError('Укажи точний час із часовим поясом.');
  return new Date(s).toISOString();
}
/** Convert a Kyiv wall clock; reject nonexistent DST times instead of guessing.
 * @param {string} date @param {string} hhmm */
export function planLocalTime(date, hhmm) {
  planDate(date);
  clock(hhmm);
  const wall = Date.parse(`${date}T${hhmm}:00Z`);
  const matches = [];
  for (const offset of [2, 3]) {
    const ms = wall - offset * 3600000;
    if (
      kyivDateKey(new Date(ms)) === date &&
      kyivMinuteOfDay(new Date(ms)) === Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
    )
      matches.push(ms);
  }
  if (matches.length !== 1)
    throw new PlanError(
      'Цей місцевий час пропущений або повторюється при зміні годинника. Обери інший час.',
    );
  return new Date(/** @type {number} */ (matches[0])).toISOString();
}
/** @param {typeof DEFAULT_PLAN_SETTINGS} settings @param {number} nowMs */
export function personalPlanDate(settings, nowMs) {
  const today = kyivDateKey(new Date(nowMs));
  const boundary =
    Number(settings.dayBoundary.slice(0, 2)) * 60 + Number(settings.dayBoundary.slice(3));
  return kyivMinuteOfDay(new Date(nowMs)) < boundary ? addDaysToDateKey(today, -1) : today;
}
/** @param {number} effort @param {number} contribution */
export function taskScore(effort, contribution) {
  integer(effort, 0, 2);
  integer(contribution, 0, 1);
  return /** @type {number} */ (
    /** @type {number[]} */ (
      [
        [10, 20],
        [20, 35],
        [35, 50],
      ][effort]
    )[contribution]
  );
}
/** @param {PlanState} state @param {string} kind */
export function planRecords(state, kind) {
  return Object.values(state.records).filter((r) => r.kind === kind);
}
/** @param {PlanState} state @param {string} id @param {string} kind */
function get(state, id, kind) {
  const r = state.records[id];
  if (!r || r.kind !== kind) throw new PlanError('Запис не знайдений. Онови план.', 404);
  return r;
}
/** @param {PlanState} state @param {any} task */
function resultOf(state, task) {
  return get(state, task.resultId, 'result');
}
/** @param {any} result */
function validReports(result) {
  return result.reports.filter((/** @type {any} */ r) => !r.retracted);
}
/** @param {PlanState} state @param {any} task */
export function taskFacts(state, task) {
  const result = resultOf(state, task);
  const onTime = Math.max(
    task.baseline ?? 0,
    ...validReports(result)
      .filter((/** @type {any} */ r) => r.actualAt <= task.dueAt)
      .map((/** @type {any} */ r) => r.units),
  );
  const remaining = Math.max(0, result.target - onTime);
  const risk =
    task.acceptedAt && task.status === 'accepted'
      ? Math.ceil((task.penaltyXp * remaining) / result.target)
      : 0;
  return {
    units: result.units,
    target: result.target,
    credited: result.credited,
    onTimeUnits: onTime,
    risk,
    done: result.units >= result.target,
  };
}
/** @param {PlanState} state */
export function planWallet(state) {
  const risk = planRecords(state, 'task').reduce(
    (sum, t) => sum + (t.status === 'accepted' && !t.settledAt ? taskFacts(state, t).risk : 0),
    0,
  );
  const reserved = Math.min(state.balance, risk);
  return {
    balance: state.balance,
    experience: state.experience,
    risk,
    reserved,
    available: state.balance - reserved,
  };
}

/** @param {PlanState} state @param {number} nowMs @param {any[]} [events] */
export function planView(state, nowMs, events = []) {
  return {
    revision: state.revision,
    now: new Date(nowMs).toISOString(),
    today: personalPlanDate(state.settings, nowMs),
    settings: state.settings,
    primaryRewardId: state.primaryRewardId,
    wallet: planWallet(state),
    tasks: planRecords(state, 'task').map((t) => ({
      ...t,
      facts: taskFacts(state, t),
      lastReport:
        resultOf(state, t)
          .reports.filter((/** @type {any} */ r) => !r.retracted)
          .at(-1) ?? null,
    })),
    goals: planRecords(state, 'goal'),
    rewards: planRecords(state, 'reward'),
    coupons: planRecords(state, 'coupon'),
    shifts: planRecords(state, 'shift'),
    events,
    suggestions: REWARD_SUGGESTIONS,
  };
}

/** A single deterministic reducer is used by API, assistant and scheduler.
 * No provider writes or model arithmetic. Persistence atomically records its events.
 * @param {PlanState} original @param {{op:string,id?:string,commandId:string,payload?:any}} command @param {number} nowMs */
export function applyPlanCommand(original, command, nowMs) {
  const state = structuredClone(original),
    now = new Date(nowMs).toISOString(),
    p = command.payload ?? {};
  if (!p || typeof p !== 'object' || Array.isArray(p))
    throw new PlanError('Перевір параметри дії.');
  for (const key of ['calendar', 'timeSensitive', 'repeatable', 'primary'])
    if (p[key] !== undefined && typeof p[key] !== 'boolean')
      throw new PlanError('Прапорці задачі й винагороди мають бути явними «так» або «ні».');
  const id = text(command.id, 100),
    op = command.op;
  /** @type {any[]} */ const events = [];
  let receipt = { message: 'Збережено.', id, reportId: '' };
  /** @param {string} kind @param {string} title @param {number} delta @param {number} experienceDelta @param {any} [detail] */
  function event(kind, title, delta = 0, experienceDelta = 0, detail = {}) {
    if (state.balance + delta < 0 || state.experience + experienceDelta < 0)
      throw new PlanError('Недостатньо XP для цієї зміни.', 409);
    state.balance += delta;
    state.experience += experienceDelta;
    events.push({
      id: `${command.commandId}:${events.length}`,
      kind,
      title,
      delta,
      experienceDelta,
      balance: state.balance,
      at: now,
      recordId: id || null,
      ...detail,
    });
  }
  /** @param {any} task @param {boolean} [first] */
  function settle(task, first = false) {
    const requested = taskFacts(state, task).risk;
    if (first) {
      task.settledAt = now;
      task.penaltyRequested = requested;
      task.penaltyApplied = Math.min(state.balance, requested);
      event('deadline', task.title, -task.penaltyApplied, 0, {
        taskId: task.id,
        requested,
        applied: task.penaltyApplied,
        onTimeUnits: taskFacts(state, task).onTimeUnits,
      });
    } else {
      const refund = Math.max(0, task.penaltyApplied - requested);
      task.penaltyRequested = requested;
      task.penaltyApplied -= refund;
      if (refund) event('penalty-correction', task.title, refund, 0, { taskId: task.id });
    }
  }
  // A delayed cron must settle known expired promises before a new earning/spend.
  // At zero, the uncollected part is recorded once and never becomes future debt.
  for (const t of planRecords(state, 'task')
    .filter((t) => t.status === 'accepted' && !t.settledAt && Date.parse(t.settleAfter) <= nowMs)
    .sort((a, b) => a.settleAfter.localeCompare(b.settleAfter) || a.id.localeCompare(b.id)))
    settle(t, true);
  if (op === '_settle') {
    /* scheduler only */
  } else if (op === '_calendar') {
    const task = get(state, id, 'task');
    task.calendarState = p.calendarState;
    task.calendarEventId = p.calendarEventId ?? null;
    task.calendarCheckedAt = now;
    task.calendarRetryAt =
      p.calendarState === 'error' ? new Date(nowMs + 900000).toISOString() : null;
  } else if (op === '_notice') {
    if (id) {
      const task = get(state, id, 'task');
      task.notices ??= {};
      task.notices[p.key] = now;
    } else {
      state.records['notice-evening'] = { id: 'notice-evening', kind: 'notice', date: p.date };
    }
  } else if (op === 'settings') {
    const settings = { ...state.settings };
    if (p.enabled != null) {
      if (typeof p.enabled !== 'boolean') throw new PlanError();
      settings.enabled = p.enabled;
    }
    if (p.penaltyPercent != null) settings.penaltyPercent = integer(p.penaltyPercent, 1, 100);
    if (p.dayBoundary != null) settings.dayBoundary = clock(p.dayBoundary);
    if (p.reportGraceHours != null) settings.reportGraceHours = integer(p.reportGraceHours, 0, 48);
    if (p.eveningAt != null) settings.eveningAt = clock(p.eveningAt);
    settings.reviewedAt ??= now;
    state.settings = settings;
    if (p.primaryRewardId !== undefined) {
      if (p.primaryRewardId) get(state, p.primaryRewardId, 'reward');
      state.primaryRewardId = p.primaryRewardId || null;
    }
    event('settings', 'Налаштування для нових задач');
  } else if (op === 'task-save') {
    const previous = id ? get(state, id, 'task') : null;
    if (previous && previous.status !== 'draft')
      throw new PlanError(
        'Умови прийнятої задачі зафіксовані. Можна змінити початок або узгодити виняток.',
        409,
      );
    const date = planDate(p.date),
      title = text(p.title, 180, true),
      criterion = text(p.criterion, 500, true);
    const target = integer(p.target ?? 1, 1, 100000000),
      effort = integer(p.effort ?? 1, 0, 2),
      contribution = integer(p.contribution ?? 0, 0, 1);
    const xp = p.xp ?? taskScore(effort, contribution);
    if (!XP_BANDS.includes(xp)) throw new PlanError('Обери 10, 20, 35 або 50 XP.');
    const deadlineKind = p.deadlineKind ?? 'day';
    if (!['day', 'time', 'shift'].includes(deadlineKind))
      throw new PlanError('Обери межу дня, точний час або зміну.');
    const dueAt =
      deadlineKind === 'day'
        ? planLocalTime(addDaysToDateKey(date, 1), state.settings.dayBoundary)
        : iso(p.dueAt);
    const startAt = p.startAt ? iso(p.startAt) : null,
      endAt = p.endAt ? iso(p.endAt) : null;
    if (startAt && startAt > dueAt) throw new PlanError('Початок має бути до крайнього строку.');
    if (p.calendar && (!startAt || !endAt || endAt <= startAt))
      throw new PlanError('Для календаря обери реальний початок і кінець блоку.');
    if (endAt && (endAt > dueAt || !startAt || endAt <= startAt))
      throw new PlanError('Перевір тривалість блоку.');
    if (p.goalId) get(state, p.goalId, 'goal');
    if (p.rewardId) get(state, p.rewardId, 'reward');
    if (p.timeSensitive && target !== 1)
      throw new PlanError('Умова «встигнути до» має один результат.');
    const taskId = id || `task-${command.commandId}`,
      resultId = previous?.resultId ?? `result-${command.commandId}`;
    if (
      planRecords(state, 'task').filter((t) => t.date === date && t.status === 'draft').length >=
        50 &&
      !previous
    )
      throw new PlanError('На один день можна підготувати до 50 задач.');
    if (
      previous?.fromTaskId &&
      (xp !== previous.xp || target !== previous.target || criterion !== previous.criterion)
    )
      throw new PlanError(
        'Продовження зберігає критерій і спільний бюджет XP. Для іншого результату створи нову задачу.',
      );
    if (!previous?.fromTaskId)
      state.records[resultId] = {
        id: resultId,
        kind: 'result',
        xp,
        target,
        units: 0,
        credited: 0,
        reports: [],
        createdAt: now,
      };
    state.records[taskId] = {
      id: taskId,
      kind: 'task',
      date,
      title,
      criterion,
      resultId,
      xp,
      target,
      unit: text(p.unit, 24) || 'крок',
      effort,
      contribution,
      deadlineKind,
      dueAt,
      startAt,
      endAt,
      timeSensitive: Boolean(p.timeSensitive),
      firstStep: text(p.firstStep, 300),
      estimateMinutes: integer(p.estimateMinutes ?? 0, 0, 1440),
      goalId: p.goalId || null,
      rewardId: p.rewardId || null,
      remindMinutes: p.remindMinutes == null ? null : integer(p.remindMinutes, 0, 1440),
      calendar: Boolean(p.calendar),
      calendarState: 'none',
      calendarEventId: null,
      status: 'draft',
      createdAt: previous?.createdAt ?? now,
      baseline: 0,
    };
    if (previous?.fromTaskId) {
      state.records[taskId].fromTaskId = previous.fromTaskId;
      state.records[taskId].baseline = previous.baseline;
    }
    receipt.id = taskId;
    event('draft', title);
  } else if (op === 'task-delete') {
    const task = get(state, id, 'task');
    if (task.status !== 'draft')
      throw new PlanError('Прийняту обіцянку не можна стерти без наслідку.', 409);
    delete state.records[id];
    if (!planRecords(state, 'task').some((t) => t.resultId === task.resultId))
      delete state.records[task.resultId];
    event('draft-deleted', task.title);
  } else if (op === 'accept') {
    if (!state.settings.enabled) throw new PlanError('Спершу переглянь і ввімкни правила плану.');
    const date = planDate(p.date);
    const tasks = planRecords(state, 'task').filter(
      (t) => t.status === 'draft' && t.date === date && (!id || t.id === id),
    );
    if (!tasks.length) throw new PlanError('Немає чернеток для прийняття. Онови план.', 409);
    for (const t of tasks) {
      if (resultOf(state, t).units >= t.target)
        throw new PlanError(
          `Результат «${t.title}» уже зроблено. Прибери цю чернетку перед прийняттям.`,
        );
      if (Date.parse(t.dueAt) <= nowMs)
        throw new PlanError(`Строк «${t.title}» уже минув. Уточни чернетку.`);
      if (
        planRecords(state, 'task').some(
          (other) =>
            other.id !== t.id &&
            other.resultId === t.resultId &&
            other.status === 'accepted' &&
            !other.settledAt,
        )
      )
        throw new PlanError('Для цього результату вже є активна обіцянка.', 409);
      t.status = 'accepted';
      t.acceptedAt = now;
      t.baseline = resultOf(state, t).units;
      t.penaltyPercent = state.settings.penaltyPercent;
      t.penaltyXp = Math.ceil((t.xp * state.settings.penaltyPercent) / 100);
      t.settleAfter = new Date(
        Date.parse(t.dueAt) + state.settings.reportGraceHours * 3600000,
      ).toISOString();
      t.reportGraceHours = state.settings.reportGraceHours;
      t.calendarState = t.calendar ? 'pending' : 'none';
      event('accepted', t.title, 0, 0, {
        taskId: t.id,
        dueAt: t.dueAt,
        xp: t.xp,
        penaltyXp: t.penaltyXp,
      });
    }
    receipt.message = `Прийнято задач: ${tasks.length}.`;
  } else if (op === 'report' || op === 'undo-report') {
    const task = get(state, id, 'task'),
      result = resultOf(state, task);
    if (!task.acceptedAt || !['accepted', 'excepted'].includes(task.status))
      throw new PlanError('Факт виконання доступний для прийнятої задачі.', 409);
    if (op === 'report') {
      const units = integer(p.units, 0, result.target),
        actualAt = iso(p.actualAt ?? now);
      const firstAcceptance = planRecords(state, 'task')
        .filter((t) => t.resultId === result.id && t.acceptedAt)
        .map((t) => t.acceptedAt)
        .sort()[0];
      if (actualAt > now || actualAt < firstAcceptance)
        throw new PlanError('Час факту має бути після прийняття й до поточного моменту.');
      const eligibleUnits = task.timeSensitive && actualAt > task.dueAt ? 0 : units;
      if (result.reports.length >= 1000)
        throw new PlanError('Досягнуто межі звітів цього результату.');
      const reportId = `report-${command.commandId}`;
      result.reports.push({
        id: reportId,
        units: eligibleUnits,
        observedUnits: units,
        actualAt,
        recordedAt: now,
        retracted: false,
      });
      receipt.reportId = reportId;
    } else {
      const report = result.reports.find(
        (/** @type {any} */ r) => r.id === p.reportId && !r.retracted,
      );
      if (!report || nowMs - Date.parse(report.recordedAt) > 600000)
        throw new PlanError('Швидке скасування доступне протягом 10 хвилин.', 409);
      report.retracted = true;
    }
    const units = Math.max(0, ...validReports(result).map((/** @type {any} */ r) => r.units)),
      credited = Math.floor((result.xp * units) / result.target),
      delta = credited - result.credited;
    event(op === 'report' ? 'earned' : 'report-reversed', task.title, delta, delta, {
      taskId: id,
      actualAt: p.actualAt ?? now,
      units,
      reportId: receipt.reportId || p.reportId,
    });
    result.units = units;
    result.credited = credited;
    for (const t of planRecords(state, 'task').filter(
      (t) => t.resultId === result.id && t.status === 'accepted' && t.settledAt,
    )) {
      if (op === 'undo-report') {
        const next = taskFacts(state, t).risk,
          extra = Math.max(0, next - t.penaltyRequested),
          applied = Math.min(state.balance, extra);
        if (extra) {
          t.penaltyApplied += applied;
          t.penaltyRequested = next;
          event('penalty-correction', t.title, -applied, 0, {
            taskId: t.id,
            requested: extra,
            applied,
          });
        }
      }
      settle(t);
    }
    receipt.message =
      delta > 0
        ? `+${delta} XP за результат.`
        : op === 'undo-report'
          ? 'Позначку скасовано.'
          : 'Факт збережено.';
  } else if (['start', 'move-start', 'snooze', 'exception', 'forfeit'].includes(op)) {
    const task = get(state, id, 'task');
    if (task.status !== 'accepted') throw new PlanError('Задача має бути в прийнятому плані.', 409);
    if (op === 'start') {
      task.startedAt ??= now;
      event('started', task.title);
    }
    if (op === 'move-start') {
      const startAt = iso(p.startAt);
      if (startAt > task.dueAt || startAt < now || task.calendar)
        throw new PlanError(
          'Обери майбутній початок до строку. Календарний блок змінюється окремо в календарі.',
        );
      task.startAt = startAt;
      task.reminderVersion = (task.reminderVersion ?? 0) + 1;
      event('start-moved', task.title);
    }
    if (op === 'snooze') {
      task.snoozeUntil = new Date(nowMs + integer(p.minutes ?? 15, 5, 120) * 60000).toISOString();
      task.reminderVersion = (task.reminderVersion ?? 0) + 1;
      event('signal-snoozed', task.title);
    }
    if (op === 'exception') {
      task.exceptionReason = text(p.reason, 500, true);
      if (task.settledAt && task.penaltyApplied) {
        event('exception-refund', task.title, task.penaltyApplied, 0, {
          taskId: id,
          reason: task.exceptionReason,
        });
        task.penaltyApplied = 0;
      }
      task.status = 'excepted';
      task.settledAt ??= now;
      event('exception', task.title, 0, 0, { taskId: id, reason: task.exceptionReason });
    }
    if (op === 'forfeit') {
      if (!task.settledAt) settle(task, true);
      task.forfeitedAt = now;
      event('forfeited', task.title, 0, 0, { taskId: id });
    }
  } else if (op === 'recommit') {
    const task = get(state, id, 'task');
    if (
      !['accepted', 'excepted'].includes(task.status) ||
      task.timeSensitive ||
      !task.settledAt ||
      taskFacts(state, task).done
    )
      throw new PlanError('Спочатку зафіксуй підсумок старої обіцянки.', 409);
    const date = planDate(p.date),
      nextId = `task-${command.commandId}`;
    state.records[nextId] = {
      ...task,
      id: nextId,
      date,
      status: 'draft',
      acceptedAt: null,
      settledAt: null,
      penaltyRequested: 0,
      penaltyApplied: 0,
      forfeitedAt: null,
      dueAt: planLocalTime(addDaysToDateKey(date, 1), state.settings.dayBoundary),
      deadlineKind: 'day',
      calendar: false,
      calendarState: 'none',
      calendarEventId: null,
      startAt: null,
      endAt: null,
      startedAt: null,
      snoozeUntil: null,
      fromTaskId: id,
      baseline: resultOf(state, task).units,
      createdAt: now,
    };
    receipt.id = nextId;
    event('recommit-draft', task.title);
  } else if (op === 'goal-save') {
    const goalId = id || `goal-${command.commandId}`;
    const previous = id ? get(state, id, 'goal') : null;
    state.records[goalId] = {
      id: goalId,
      kind: 'goal',
      title: text(p.title, 180, true),
      why: text(p.why, 500),
      horizon: p.horizon === 'month' ? 'month' : 'week',
      dueDate: planDate(p.dueDate),
      createdAt: previous?.createdAt ?? now,
    };
    receipt.id = goalId;
    event('goal', state.records[goalId].title);
  } else if (op === 'reward-save') {
    const rewardId = id || `reward-${command.commandId}`,
      previous = id ? get(state, id, 'reward') : null;
    if (
      previous &&
      planRecords(state, 'coupon').some((c) => c.rewardId === id && c.status !== 'refunded')
    )
      throw new PlanError('Отриману винагороду збережено в історії. Створи новий варіант.', 409);
    const scale = p.scale ?? 'near';
    if (!['near', 'middle', 'large'].includes(scale))
      throw new PlanError('Обери масштаб винагороди.');
    const gate = p.gate ?? null;
    if (
      gate &&
      (!['milestone', 'purchase'].includes(gate.kind) || typeof gate.confirmed !== 'boolean')
    )
      throw new PlanError('Перевір умову відкриття.');
    const gateReason = gate
      ? text(gate.note, 1200, gate.confirmed) || 'Умови й реальний бюджет ще не визначено.'
      : '';
    state.records[rewardId] = {
      id: rewardId,
      kind: 'reward',
      title: text(p.title, 180, true),
      why: text(p.why, 500),
      price: integer(p.price, 1, 1000000),
      scale,
      repeatable: Boolean(p.repeatable),
      gate: gate
        ? { kind: gate.kind, confirmed: gate.confirmed, note: gateReason, checkedAt: now }
        : scale === 'large'
          ? {
              kind: 'purchase',
              confirmed: false,
              note: 'Потрібно визначити умови й реальний бюджет.',
              checkedAt: null,
            }
          : null,
      archived: false,
      createdAt: previous?.createdAt ?? now,
    };
    if (p.primary) state.primaryRewardId = rewardId;
    else if (p.primary === false && state.primaryRewardId === rewardId)
      state.primaryRewardId = null;
    receipt.id = rewardId;
    event('reward-saved', state.records[rewardId].title);
  } else if (op === 'reward-archive') {
    const reward = get(state, id, 'reward');
    reward.archived = true;
    if (state.primaryRewardId === id) state.primaryRewardId = null;
    event('reward-archived', reward.title);
  } else if (op === 'redeem') {
    const reward = get(state, id, 'reward');
    if (
      reward.archived ||
      (!reward.repeatable &&
        planRecords(state, 'coupon').some((c) => c.rewardId === id && c.status !== 'refunded'))
    )
      throw new PlanError('Цю винагороду вже отримано.', 409);
    if (reward.gate && !reward.gate.confirmed)
      throw new PlanError('Спочатку підтвердь реальну умову винагороди.');
    if (reward.price > planWallet(state).available)
      throw new PlanError(
        'Зараз недостатньо доступних XP. Частина балансу покриває відкриті обіцянки.',
        409,
      );
    const couponId = `coupon-${command.commandId}`;
    state.records[couponId] = {
      id: couponId,
      kind: 'coupon',
      rewardId: id,
      title: reward.title,
      price: reward.price,
      status: 'ready',
      createdAt: now,
    };
    receipt.id = couponId;
    event('redeemed', reward.title, -reward.price, 0, { couponId });
  } else if (op === 'coupon-use' || op === 'coupon-refund') {
    const coupon = get(state, id, 'coupon');
    if (coupon.status !== 'ready') throw new PlanError('Купон уже використано або повернено.', 409);
    coupon.status = op === 'coupon-use' ? 'used' : 'refunded';
    coupon.finishedAt = now;
    event(
      op === 'coupon-use' ? 'coupon-used' : 'coupon-refunded',
      coupon.title,
      op === 'coupon-refund' ? coupon.price : 0,
    );
  } else if (op === 'shift-open') {
    if (planRecords(state, 'shift').some((s) => !s.endedAt))
      throw new PlanError('Уже є відкрита зміна.', 409);
    const reviewAt = iso(p.reviewAt);
    if (Date.parse(reviewAt) <= nowMs || Date.parse(reviewAt) > nowMs + 36 * 3600000)
      throw new PlanError('Межа перевірки зміни — протягом наступних 36 годин.');
    const shiftId = `shift-${command.commandId}`;
    state.records[shiftId] = {
      id: shiftId,
      kind: 'shift',
      date: personalPlanDate(state.settings, nowMs),
      startedAt: now,
      reviewAt,
      endedAt: null,
    };
    for (const t of planRecords(state, 'task').filter(
      (t) =>
        t.status === 'accepted' &&
        t.deadlineKind === 'shift' &&
        !t.shiftId &&
        !t.settledAt &&
        t.date === personalPlanDate(state.settings, nowMs),
    )) {
      t.shiftId = shiftId;
      t.dueAt = reviewAt < t.dueAt ? reviewAt : t.dueAt;
      t.settleAfter = new Date(Date.parse(t.dueAt) + t.reportGraceHours * 3600000).toISOString();
    }
    receipt.id = shiftId;
    event('shift-opened', 'Робочу зміну розпочато');
  } else if (op === 'shift-close') {
    const shift = get(state, id, 'shift');
    if (shift.endedAt) throw new PlanError('Зміну вже закрито.', 409);
    shift.endedAt = iso(p.endedAt ?? now);
    if (shift.endedAt > now || shift.endedAt < shift.startedAt)
      throw new PlanError('Перевір час завершення зміни.');
    for (const t of planRecords(state, 'task').filter((t) => t.shiftId === id && !t.settledAt)) {
      t.shiftEndedAt = shift.endedAt;
      t.dueAt = shift.endedAt < t.dueAt ? shift.endedAt : t.dueAt;
      t.settleAfter = new Date(Date.parse(t.dueAt) + t.reportGraceHours * 3600000).toISOString();
    }
    event('shift-closed', 'Зміну закрито. Внеси фактичні результати.');
  } else throw new PlanError('Невідома дія.');
  // A shift promise always has a finite review boundary and a stable shift id.
  if (op === 'accept')
    for (const t of planRecords(state, 'task').filter(
      (t) => t.acceptedAt === now && t.deadlineKind === 'shift',
    )) {
      const shift = planRecords(state, 'shift').find((s) => !s.endedAt && s.date === t.date);
      if (shift) {
        t.shiftId = shift.id;
        t.dueAt = shift.reviewAt < t.dueAt ? shift.reviewAt : t.dueAt;
        t.settleAfter = new Date(Date.parse(t.dueAt) + t.reportGraceHours * 3600000).toISOString();
      }
    }
  state.revision++;
  return { state, events, receipt };
}
