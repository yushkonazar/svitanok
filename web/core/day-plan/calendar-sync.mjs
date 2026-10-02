// Repair a plan/Google Calendar write interrupted after the D1 transaction.
// The pending marker is committed with the plan edit; PATCH and DELETE are
// idempotent, so an alarm may safely retry after an isolate is terminated.
import { getCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from '../../google.mjs';
import { kyivMs } from './store.mjs';
import { assistantHomeTarget } from '../tg/home.mjs';
import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';

/** @param {Env} env @param {string} text @param {number} nowMs */
async function tellOwner(env, text, nowMs) {
  const to = assistantHomeTarget(env);
  if (!to) return false;
  await enqueueOutbox(
    env,
    {
      chatId: to.chatId,
      threadId: to.threadId,
      kind: 'send',
      payload: { text },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) => {
    console.error('plan-calendar-sync: доставка відкладена', e?.message);
  });
  return true;
}

/** @param {Env} env @param {any} item @param {number} nowMs */
async function alertIfStale(env, item, nowMs) {
  if (!env.DB) return;
  if (
    item.calendar_sync_alerted_at ||
    nowMs - Date.parse(item.calendar_sync_pending_at ?? '') < 15 * 60_000
  )
    return;
  if (
    !(await tellOwner(
      env,
      `⚠️ Не вдалося узгодити «${item.title}» із календарем. План поки очікує синхронізації; перевір цей блок.`,
      nowMs,
    ))
  )
    return;
  await env.DB.prepare(
    'UPDATE plan_items SET calendar_sync_alerted_at = ? WHERE id = ? AND calendar_sync_pending = 1 AND calendar_sync_alerted_at IS NULL',
  )
    .bind(new Date(nowMs).toISOString(), item.id)
    .run();
}

/** @param {Env} env @param {number} [nowMs] */
export async function reconcilePlanCalendar(env, nowMs = Date.now()) {
  if (!env.DB) return { checked: 0, repaired: 0 };
  const rows = await env.DB.prepare(
    `SELECT * FROM plan_items WHERE calendar_sync_pending = 1
     AND (calendar_sync_pending_at IS NULL OR calendar_sync_pending_at <= ?)
     ORDER BY date, id LIMIT 20`,
  )
    .bind(new Date(nowMs - 60_000).toISOString())
    .all();
  let repaired = 0;
  for (const item of rows.results ?? []) {
    try {
      if (!item.event_id) throw new Error('немає ID події');
      const event = await getCalendarEvent(env, String(item.event_id));
      if (event?.hasAttendees) throw new Error('у події зʼявились гості');
      const expectedTitle =
        item.floating && item.est_min ? `${item.title} · ≈${item.est_min} хв у вікні` : item.title;
      if (event && event.title !== expectedTitle) throw new Error('назву події змінено окремо');
      if (item.status === 'skipped') {
        const removed = await deleteCalendarEvent(env, { eventId: String(item.event_id) });
        if (!removed.ok) throw new Error('Calendar не видалив подію');
        const settled = await env.DB.prepare(
          `UPDATE plan_items SET event_id = NULL, calendar_sync_pending = 0,
           calendar_sync_pending_at = NULL, calendar_sync_alerted_at = NULL
           WHERE id = ? AND event_id = ? AND status = 'skipped' AND calendar_sync_pending = 1`,
        )
          .bind(item.id, item.event_id)
          .run();
        if ((settled.meta?.changes ?? 0) !== 1) continue;
      } else {
        if (!event) throw new Error('не вдалося прочитати подію');
        const startMs = item.window_start
          ? kyivMs(String(item.date), String(item.window_start))
          : null;
        const endMs = item.window_end ? kyivMs(String(item.date), String(item.window_end)) : null;
        if (startMs == null || endMs == null || endMs <= startMs)
          throw new Error('час плану некоректний');
        if (event.startMs !== startMs || event.endMs !== endMs) {
          const updated = await updateCalendarEvent(env, {
            eventId: String(item.event_id),
            patch: {
              start: { dateTime: new Date(startMs).toISOString(), timeZone: 'Europe/Kyiv' },
              end: { dateTime: new Date(endMs).toISOString(), timeZone: 'Europe/Kyiv' },
            },
          });
          if (!updated.ok) throw new Error('Calendar не переніс подію');
        }
        const settled = await env.DB.prepare(
          `UPDATE plan_items SET calendar_sync_pending = 0,
           calendar_sync_pending_at = NULL, calendar_sync_alerted_at = NULL
           WHERE id = ? AND event_id = ? AND window_start = ? AND window_end = ? AND calendar_sync_pending = 1`,
        )
          .bind(item.id, item.event_id, item.window_start, item.window_end)
          .run();
        if ((settled.meta?.changes ?? 0) !== 1) continue;
      }
      repaired += 1;
      await tellOwner(
        env,
        `🗓 Синхронізував «${item.title}» у плані й календарі після затримки.`,
        nowMs,
      ).catch((/** @type {any} */ e) =>
        console.error('plan-calendar-sync: звіт не доставлено', e?.message),
      );
    } catch (/** @type {any} */ e) {
      console.error('plan-calendar-sync: повтор не вдався', item.id, e?.message);
      await alertIfStale(env, item, nowMs).catch((/** @type {any} */ alertError) => {
        console.error('plan-calendar-sync: сповіщення не вдалось', alertError?.message);
      });
    }
  }
  return { checked: (rows.results ?? []).length, repaired };
}
