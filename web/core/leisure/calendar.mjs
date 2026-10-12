import {
  createCalendarEvent,
  inspectCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../../google.mjs';
import { leisureDb, leisureRecord } from './store.mjs';
import { leisureId } from './model.mjs';

/** @param {Env} env @param {string} id @param {number} [nowMs] */
export async function syncLeisurePlan(env, id, nowMs = Date.now()) {
  const db = leisureDb(env),
    plan = await leisureRecord(env, id);
  if (!plan || !['pending', 'delete-pending', 'error'].includes(plan.calendarState)) return;
  const claim = await db
    .prepare(
      'UPDATE leisure_records SET sync_claim_until=? WHERE id=? AND revision=? AND sync_claim_until < ?',
    )
    .bind(nowMs + 120000, id, plan.revision, nowMs)
    .run();
  if (!claim.meta.changes) return;
  let calendarState = 'error',
    calendarId = plan.calendarId,
    lastSynced = plan.lastSynced ?? null;
  /** @type {string | undefined} */ let etag;
  try {
    const description = plan.stops
      .map(
        (/** @type {any} */ s) =>
          `${s.startAt} — ${s.title}\n${s.address ?? ''}\n${s.sourceUrl ?? ''}`,
      )
      .join('\n\n');
    const location = plan.stops
      .map((/** @type {any} */ s) => s.address)
      .filter(Boolean)
      .join(' → ');
    const desired = {
      title: plan.title,
      startAt: plan.startAt,
      endAt: plan.endAt,
      location,
      description,
    };
    if (calendarId && lastSynced) {
      const inspection = await inspectCalendarEvent(env, calendarId),
        current = inspection.event;
      if (inspection.state === 'missing') {
        if (!plan.calendar || plan.status === 'cancelled') {
          calendarId = null;
          lastSynced = null;
          return await finish('none');
        }
        // Do not resurrect an event the owner deleted in Google Calendar.
        return await finish('conflict');
      }
      if (!current) return await finish('error');
      etag = inspection.etag;
      if (
        current.hasAttendees ||
        (inspection.audit?.title ?? current.title) !== lastSynced.title ||
        (lastSynced.location != null && inspection.audit?.location !== lastSynced.location) ||
        (lastSynced.description != null &&
          inspection.audit?.description !== lastSynced.description) ||
        current.startMs !== Date.parse(lastSynced.startAt) ||
        current.endMs !== Date.parse(lastSynced.endAt)
      )
        return await finish('conflict');
    }
    if (!plan.calendar || plan.status === 'cancelled') {
      const result = calendarId
        ? await deleteCalendarEvent(env, { eventId: calendarId, etag })
        : { ok: true, conflict: false };
      if (result.conflict) return await finish('conflict');
      if (result.ok) {
        calendarId = null;
        lastSynced = null;
        calendarState = 'none';
      }
    } else {
      if (calendarId) {
        const result = await updateCalendarEvent(env, {
          eventId: calendarId,
          etag,
          patch: {
            summary: plan.title,
            start: { dateTime: plan.startAt, timeZone: 'Europe/Kyiv' },
            end: { dateTime: plan.endAt, timeZone: 'Europe/Kyiv' },
            description,
            location: plan.stops
              .map((/** @type {any} */ s) => s.address)
              .filter(Boolean)
              .join(' → '),
          },
        });
        if (result.conflict) return await finish('conflict');
        if (result.ok) {
          calendarState = 'synced';
          lastSynced = desired;
        }
      } else {
        const eventId = `svl${(await leisureId('calendar', id)).slice('calendar-'.length)}`;
        const result = await createCalendarEvent(env, {
          id: eventId,
          title: plan.title,
          startIso: plan.startAt,
          endIso: plan.endAt,
          location: plan.stops
            .map((/** @type {any} */ s) => s.address)
            .filter(Boolean)
            .join(' → '),
          description,
          silent: true,
        });
        if (result.exists && result.id) {
          // A lost POST response can be retried safely. A pre-existing event
          // must match the intended details before it is claimed as synchronized.
          calendarId = result.id;
          const inspection = await inspectCalendarEvent(env, calendarId),
            current = inspection.event;
          if (!current) return await finish('error');
          if (
            current.hasAttendees ||
            (inspection.audit?.title ?? current.title) !== desired.title ||
            (inspection.audit &&
              (inspection.audit.location !== desired.location ||
                inspection.audit.description !== desired.description)) ||
            current.startMs !== Date.parse(desired.startAt) ||
            current.endMs !== Date.parse(desired.endAt)
          )
            return await finish('conflict');
          calendarState = 'synced';
          lastSynced = desired;
        } else if (result.ok && result.id) {
          calendarId = result.id;
          calendarState = 'synced';
          lastSynced = desired;
        }
      }
    }
    await finish(calendarState);
  } catch {
    await finish('error');
  }
  /** @param {string} state */
  async function finish(state) {
    await db
      .prepare(
        "UPDATE leisure_records SET data_json=json_set(data_json,'$.calendarState',?,'$.calendarId',?,'$.lastSynced',json(?),'$.calendarRetryAt',?,'$.calendarAttempts',?),sync_claim_until=0 WHERE id=? AND revision=?",
      )
      .bind(
        state,
        calendarId ?? null,
        JSON.stringify(lastSynced),
        state === 'error'
          ? nowMs +
              Math.min(6 * 3600000, 300000 * 2 ** Math.min(7, Number(plan.calendarAttempts ?? 0)))
          : 0,
        state === 'error' ? Number(plan.calendarAttempts ?? 0) + 1 : 0,
        id,
        plan.revision,
      )
      .run();
  }
}
/** @param {Env} env @param {number} [nowMs] */
export async function reconcileLeisureCalendar(env, nowMs = Date.now()) {
  if (!env.DB) return;
  const { results } = await env.DB.prepare(
    "SELECT id FROM leisure_records WHERE kind='plan' AND json_extract(data_json,'$.calendarState') IN ('pending','delete-pending','error') AND sync_claim_until < ? AND COALESCE(json_extract(data_json,'$.calendarRetryAt'),0) <= ? LIMIT 12",
  )
    .bind(nowMs, nowMs)
    .all();
  for (const row of results) await syncLeisurePlan(env, String(row.id), nowMs);
}
