import { readPlanState, executePlanCommand, updatePlanCalendar } from './store.mjs';
import { planRecords, taskFacts } from './model.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { isQuietMinute, parseHhmm } from '../../settings-core.mjs';
import { kyivDateKey, kyivMinuteOfDay } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { createCalendarEvent, inspectCalendarEvent } from '../../google.mjs';
import { planButton } from './links.mjs';

/** During expand rollout the old planner still works until the owner chooses the new one.
 * @param {Env} env */
export async function manualPlanEnabled(env) {
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare('SELECT data_json FROM motivation_account WHERE id=1')
      .bind()
      .first();
    return row ? JSON.parse(String(row.data_json)).settings?.enabled === true : false;
  } catch (error) {
    if (/no such table.*motivation_account/.test(String(error))) return false;
    throw error;
  }
}

/** Revalidate just before sending: a completed task or stale snooze never pings.
 * @param {Env} env @param {any} notice @param {number} nowMs */
export async function renderPlanNotice(env, notice, nowMs) {
  const state = await readPlanState(env);
  if (!state.settings.enabled) return null;
  const settings = await loadSettings(env),
    minute = kyivMinuteOfDay(new Date(nowMs));
  if (isQuietMinute(settings, minute))
    return {
      deferSeconds:
        (((parseHhmm(settings.quiet.to) ?? 480) - minute + 1440) % 1440 || 1440) * 60 + 60,
    };
  if (!notice.taskId) {
    if (notice.date !== addDaysToDateKey(kyivDateKey(new Date(nowMs)), 1)) return null;
    if (planRecords(state, 'task').some((t) => t.date === notice.date && t.acceptedAt)) return null;
    return {
      text: 'Завтра починається з твого вибору. Відкрий «План», запиши важливі справи й прийми реалістичний список.',
    };
  }
  const task = state.records[notice.taskId];
  if (
    !task ||
    task.status !== 'accepted' ||
    task.forfeitedAt ||
    taskFacts(state, task).done ||
    (task.reminderVersion ?? 0) !== notice.version
  )
    return null;
  if (notice.kind === 'start' && (task.startedAt || task.dueAt <= new Date(nowMs).toISOString()))
    return null;
  if (notice.kind === 'report' && task.settledAt) return null;
  return {
    text:
      notice.kind === 'report'
        ? `Час для факту: ${task.title}. Строк минув; можна внести результат і його справжній час. Вікно звіту не подовжує виконання.`
        : `${task.title}\n${task.firstStep || task.criterion}\nСтрок: ${new Date(task.dueAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`,
  };
}

/** @param {Env} env @param {number} [nowMs] */
export async function motivationTask(env, nowMs = Date.now()) {
  if (!env.DB) return;
  let state = await readPlanState(env),
    now = new Date(nowMs).toISOString();
  if (
    planRecords(state, 'task').some(
      (t) => t.status === 'accepted' && !t.settledAt && t.settleAfter <= now,
    )
  ) {
    await executePlanCommand(
      env,
      { op: '_settle', commandId: `settle-${crypto.randomUUID()}` },
      nowMs,
      { internal: true },
    );
    state = await readPlanState(env);
  }
  if (!state.settings.enabled) return;
  const home = assistantHomeTarget(env);
  if (!home || isQuietMinute(await loadSettings(env), kyivMinuteOfDay(new Date(nowMs)))) return;
  const tomorrow = addDaysToDateKey(kyivDateKey(new Date(nowMs)), 1),
    evening =
      Number(state.settings.eveningAt.slice(0, 2)) * 60 + Number(state.settings.eveningAt.slice(3));
  if (
    kyivMinuteOfDay(new Date(nowMs)) >= evening &&
    state.records['notice-evening']?.date !== tomorrow &&
    !planRecords(state, 'task').some((t) => t.date === tomorrow && t.acceptedAt)
  )
    await notice(null, 'evening', tomorrow);
  let count = 0;
  for (const t of planRecords(state, 'task')) {
    if (count >= 20) break;
    if (t.status !== 'accepted' || t.forfeitedAt || taskFacts(state, t).done) continue;
    const version = t.reminderVersion ?? 0;
    const reminderAt =
      t.snoozeUntil ??
      (t.remindMinutes != null
        ? new Date(Date.parse(t.startAt ?? t.dueAt) - t.remindMinutes * 60000).toISOString()
        : null);
    if (
      !t.startedAt &&
      reminderAt &&
      reminderAt <= now &&
      now < t.dueAt &&
      !t.notices?.[`start-${version}`]
    ) {
      await notice(t, 'start', `start-${version}`);
      count++;
    }
    if (t.dueAt <= now && !t.settledAt && !t.notices?.['report']) {
      await notice(t, 'report', 'report');
      count++;
    }
  }
  /** @param {any} task @param {string} kind @param {string} key */
  async function notice(task, kind, key) {
    if (!home) return;
    const noticeHash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(`${task?.id ?? 'evening'}:${key}`),
        ),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const commandId = `notice-${noticeHash}`;
    const param = task ? `plan_task_${task.id}` : `plan_date_${key}`;
    const button = planButton(env, param, home.chatId);
    await executePlanCommand(
      env,
      { op: '_notice', id: task?.id, commandId, payload: { key, date: key } },
      nowMs,
      {
        internal: true,
        outbox: [
          {
            id: `${String(nowMs).padStart(15, '0')}-${commandId}`,
            ...home,
            payload: {
              text: 'План Світанку',
              plan_notice: {
                taskId: task?.id ?? null,
                kind,
                date: key,
                version: task?.reminderVersion ?? 0,
              },
              ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
            },
          },
        ],
      },
    );
  }
}

/** Calendar is a projection of an explicitly selected block. Stable ids make retries safe.
 * No external edit can silently rewrite an accepted deadline.
 * @param {Env} env @param {number} [nowMs] */
export async function motivationCalendarTask(env, nowMs = Date.now()) {
  if (!env.DB) return;
  const state = await readPlanState(env);
  for (const t of planRecords(state, 'task')
    .filter(
      (t) =>
        t.calendar &&
        t.acceptedAt &&
        ['pending', 'error'].includes(t.calendarState) &&
        (!t.calendarRetryAt || Date.parse(t.calendarRetryAt) <= nowMs),
    )
    .slice(0, 8)) {
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t.id))),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const eventId = `svp${hash}`,
      description = `План Світанку · ${t.id}\n${t.criterion}\nКрайній строк: ${t.dueAt}`;
    try {
      const response = await createCalendarEvent(env, {
        id: eventId,
        title: t.title,
        startIso: t.startAt,
        endIso: t.endAt,
        description,
        silent: true,
      });
      let status = response.ok ? 'synced' : 'error';
      if (response.exists) {
        const inspection = await inspectCalendarEvent(env, eventId),
          current = inspection.event;
        status =
          current &&
          !current.hasAttendees &&
          current.title === t.title &&
          current.startMs === Date.parse(t.startAt) &&
          current.endMs === Date.parse(t.endAt) &&
          inspection.audit?.description === description
            ? 'synced'
            : 'conflict';
      }
      await updatePlanCalendar(env, t.id, {
        calendarState: status,
        calendarEventId: status === 'synced' ? eventId : null,
      });
    } catch {
      await updatePlanCalendar(env, t.id, { calendarState: 'error' });
    }
  }
}
