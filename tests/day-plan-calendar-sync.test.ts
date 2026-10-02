import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcilePlanCalendar } from '../web/core/day-plan/calendar-sync.mjs';
import { getCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from '../web/google.mjs';
import { enqueueOutbox } from '../web/core/tg/outbox.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';

vi.mock('../web/google.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/google.mjs')>()),
  getCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));
vi.mock('../web/core/tg/outbox.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/core/tg/outbox.mjs')>()),
  enqueueOutbox: vi.fn(async () => 'queued'),
  drainOutbox: vi.fn(async () => undefined),
}));

const DATE = '2026-09-07';
const NOW = Date.parse('2026-09-07T12:00:00Z');

function setup() {
  const { db, stub } = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0007_instructions_plans.sql',
    '0020_plan_item_time_constraints.sql',
  ]);
  return { db, env: workerEnv({ DB: stub }) };
}

afterEach(() => {
  vi.mocked(getCalendarEvent).mockReset();
  vi.mocked(updateCalendarEvent).mockReset();
  vi.mocked(deleteCalendarEvent).mockReset();
  vi.mocked(enqueueOutbox).mockClear();
});

describe('відновлення перерваної синхронізації плану', () => {
  it('без D1 нічого не змінює', async () => {
    expect(await reconcilePlanCalendar(workerEnv(), NOW)).toEqual({ checked: 0, repaired: 0 });
  });

  it('не випереджає ще активний запит', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start, window_end,
      calendar_sync_pending, calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run(
      'fresh',
      DATE,
      'Робота',
      'cal-fresh',
      '11:00',
      '12:00',
      new Date(NOW - 10_000).toISOString(),
    );
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 0, repaired: 0 });
    expect(getCalendarEvent).not.toHaveBeenCalled();
  });

  it('переносить подію до збереженого часу й знімає мітку лише після Google', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start, window_end,
      calendar_sync_pending, calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run(
      'item-1',
      DATE,
      'Робота',
      'cal-1',
      '11:00',
      '12:00',
      new Date(NOW - 60_000).toISOString(),
    );
    vi.mocked(getCalendarEvent).mockResolvedValue({
      id: 'cal-1',
      title: 'Робота',
      startMs: Date.parse('2026-09-07T06:00:00Z'),
      endMs: Date.parse('2026-09-07T07:00:00Z'),
      hasAttendees: false,
    } as never);
    vi.mocked(updateCalendarEvent).mockResolvedValue({ ok: true });
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 1 });
    expect(updateCalendarEvent).toHaveBeenCalledWith(env, {
      eventId: 'cal-1',
      patch: {
        start: { dateTime: '2026-09-07T08:00:00.000Z', timeZone: 'Europe/Kyiv' },
        end: { dateTime: '2026-09-07T09:00:00.000Z', timeZone: 'Europe/Kyiv' },
      },
    });
    expect(
      db.prepare('SELECT calendar_sync_pending FROM plan_items WHERE id = ?').get('item-1'),
    ).toEqual({ calendar_sync_pending: 0 });
    expect(await reconcilePlanCalendar(env, NOW + 300_000)).toEqual({ checked: 0, repaired: 0 });
  });

  it('видаляє пропущений блок і прибирає старий event_id', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, calendar_sync_pending,
      calendar_sync_pending_at) VALUES (?, ?, ?, 'skipped', ?, 1, ?)`,
    ).run('item-2', DATE, 'Спорт', 'cal-2', new Date(NOW - 60_000).toISOString());
    vi.mocked(getCalendarEvent).mockResolvedValue(null);
    vi.mocked(deleteCalendarEvent).mockResolvedValue({ ok: true });
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 1 });
    expect(deleteCalendarEvent).toHaveBeenCalledWith(env, { eventId: 'cal-2' });
    expect(
      db
        .prepare('SELECT event_id, calendar_sync_pending FROM plan_items WHERE id = ?')
        .get('item-2'),
    ).toEqual({ event_id: null, calendar_sync_pending: 0 });
  });

  it('зберігає мітку для наступної спроби, якщо Calendar відмовив', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start, window_end,
      calendar_sync_pending, calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run('item-3', DATE, 'Курс', 'cal-3', '11:00', '12:00', new Date(NOW - 60_000).toISOString());
    vi.mocked(getCalendarEvent).mockResolvedValue({
      id: 'cal-3',
      title: 'Курс',
      startMs: Date.parse('2026-09-07T06:00:00Z'),
      endMs: Date.parse('2026-09-07T07:00:00Z'),
      hasAttendees: false,
    } as never);
    vi.mocked(updateCalendarEvent).mockResolvedValue({ ok: false });
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 0 });
    expect(
      db.prepare('SELECT calendar_sync_pending FROM plan_items WHERE id = ?').get('item-3'),
    ).toEqual({ calendar_sync_pending: 1 });
  });

  it('після 15 хв без успіху повідомляє власника один раз', async () => {
    const { db, env } = setup();
    env.TELEGRAM_CHAT_ID = '555';
    env.TOPIC_ASSISTANT = '99';
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start, window_end,
      calendar_sync_pending, calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run(
      'item-4',
      DATE,
      'Курс',
      'cal-4',
      '11:00',
      '12:00',
      new Date(NOW - 16 * 60_000).toISOString(),
    );
    vi.mocked(getCalendarEvent).mockResolvedValue(null);
    await reconcilePlanCalendar(env, NOW);
    expect(enqueueOutbox).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        chatId: 555,
        payload: { text: expect.stringContaining('очікує синхронізації') },
      }),
      NOW,
    );
    expect(
      db
        .prepare(
          'SELECT calendar_sync_pending, calendar_sync_alerted_at FROM plan_items WHERE id = ?',
        )
        .get('item-4'),
    ).toMatchObject({
      calendar_sync_pending: 1,
      calendar_sync_alerted_at: new Date(NOW).toISOString(),
    });
    await reconcilePlanCalendar(env, NOW + 300_000);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
  });

  it('уже оновлена подія лише завершує мітку й повідомляє власника', async () => {
    const { db, env } = setup();
    env.TELEGRAM_CHAT_ID = '555';
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start, window_end,
      calendar_sync_pending, calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run(
      'already',
      DATE,
      'Курс',
      'cal-already',
      '11:00',
      '12:00',
      new Date(NOW - 60_000).toISOString(),
    );
    vi.mocked(getCalendarEvent).mockResolvedValue({
      id: 'cal-already',
      title: 'Курс',
      startMs: Date.parse('2026-09-07T08:00:00Z'),
      endMs: Date.parse('2026-09-07T09:00:00Z'),
      hasAttendees: false,
    } as never);
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 1 });
    expect(updateCalendarEvent).not.toHaveBeenCalled();
    expect(enqueueOutbox).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        payload: { text: expect.stringContaining('Синхронізував') },
      }),
      NOW,
    );
    expect(
      db.prepare('SELECT calendar_sync_pending FROM plan_items WHERE id = ?').get('already'),
    ).toEqual({ calendar_sync_pending: 0 });
  });

  it.each([
    ['запрошені гості', { title: 'Курс', hasAttendees: true }],
    ['ручна зміна назви', { title: 'Інша подія', hasAttendees: false }],
  ])('не перезаписує %s у події календаря', async (_case, detail) => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start, window_end,
      calendar_sync_pending, calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run(
      'guarded',
      DATE,
      'Курс',
      'cal-guarded',
      '11:00',
      '12:00',
      new Date(NOW - 60_000).toISOString(),
    );
    vi.mocked(getCalendarEvent).mockResolvedValue({
      id: 'cal-guarded',
      title: detail.title,
      startMs: Date.parse('2026-09-07T06:00:00Z'),
      endMs: Date.parse('2026-09-07T07:00:00Z'),
      hasAttendees: detail.hasAttendees,
    } as never);
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 0 });
    expect(updateCalendarEvent).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT calendar_sync_pending FROM plan_items WHERE id = ?').get('guarded'),
    ).toEqual({ calendar_sync_pending: 1 });
  });

  it('невдале видалення лишає пункт у черзі для повтору', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, calendar_sync_pending,
      calendar_sync_pending_at) VALUES (?, ?, ?, 'skipped', ?, 1, ?)`,
    ).run('delete-fail', DATE, 'Спорт', 'cal-delete-fail', new Date(NOW - 60_000).toISOString());
    vi.mocked(getCalendarEvent).mockResolvedValue(null);
    vi.mocked(deleteCalendarEvent).mockResolvedValue({ ok: false });
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 0 });
    expect(
      db
        .prepare('SELECT event_id, calendar_sync_pending FROM plan_items WHERE id = ?')
        .get('delete-fail'),
    ).toEqual({ event_id: 'cal-delete-fail', calendar_sync_pending: 1 });
  });

  it('не вважає плаваючий блок чужою подією, якщо назва містить оцінку тривалості', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, floating, est_min,
      window_start, window_end, calendar_sync_pending, calendar_sync_pending_at)
      VALUES (?, ?, ?, 'planned', ?, 1, 30, ?, ?, 1, ?)`,
    ).run(
      'floating',
      DATE,
      'Обід',
      'cal-floating',
      '11:00',
      '12:00',
      new Date(NOW - 60_000).toISOString(),
    );
    vi.mocked(getCalendarEvent).mockResolvedValue({
      id: 'cal-floating',
      title: 'Обід · ≈30 хв у вікні',
      startMs: Date.parse('2026-09-07T08:00:00Z'),
      endMs: Date.parse('2026-09-07T09:00:00Z'),
      hasAttendees: false,
    } as never);
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 1 });
    expect(updateCalendarEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['без ID події', null, '11:00', '12:00'],
    ['без початку', 'cal-invalid', null, '12:00'],
    ['без кінця', 'cal-invalid', '11:00', null],
    ['час у зворотному порядку', 'cal-invalid', '12:00', '11:00'],
  ])('лишає мітку для ручного виправлення: %s', async (_name, eventId, start, end) => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, window_start,
      window_end, calendar_sync_pending, calendar_sync_pending_at)
      VALUES (?, ?, ?, 'planned', ?, ?, ?, 1, ?)`,
    ).run('invalid', DATE, 'Курс', eventId, start, end, new Date(NOW - 60_000).toISOString());
    if (eventId)
      vi.mocked(getCalendarEvent).mockResolvedValue({
        id: eventId,
        title: 'Курс',
        startMs: Date.parse('2026-09-07T06:00:00Z'),
        endMs: Date.parse('2026-09-07T07:00:00Z'),
        hasAttendees: false,
      } as never);
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 0 });
    expect(updateCalendarEvent).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT calendar_sync_pending FROM plan_items WHERE id = ?').get('invalid'),
    ).toEqual({ calendar_sync_pending: 1 });
  });

  it('не позначає стару помилку як повідомлену, якщо приватна доставка не налаштована', async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, calendar_sync_pending,
      calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, 1, ?)`,
    ).run('no-home', DATE, 'Курс', 'cal-no-home', new Date(NOW - 16 * 60_000).toISOString());
    vi.mocked(getCalendarEvent).mockResolvedValue(null);
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 0 });
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT calendar_sync_alerted_at FROM plan_items WHERE id = ?').get('no-home'),
    ).toEqual({ calendar_sync_alerted_at: null });
  });

  it('повторює недоставлене попередження після збою черги', async () => {
    const { db, env } = setup();
    env.TELEGRAM_CHAT_ID = '555';
    db.prepare(
      `INSERT INTO plan_items (id, date, title, status, event_id, calendar_sync_pending,
      calendar_sync_pending_at) VALUES (?, ?, ?, 'planned', ?, 1, ?)`,
    ).run('queue-fail', DATE, 'Курс', 'cal-queue-fail', new Date(NOW - 16 * 60_000).toISOString());
    vi.mocked(getCalendarEvent).mockResolvedValue(null);
    vi.mocked(enqueueOutbox).mockRejectedValueOnce(new Error('queue unavailable'));
    expect(await reconcilePlanCalendar(env, NOW)).toEqual({ checked: 1, repaired: 0 });
    expect(
      db.prepare('SELECT calendar_sync_alerted_at FROM plan_items WHERE id = ?').get('queue-fail'),
    ).toEqual({ calendar_sync_alerted_at: null });
    expect(await reconcilePlanCalendar(env, NOW + 60_000)).toEqual({ checked: 1, repaired: 0 });
    expect(
      db.prepare('SELECT calendar_sync_alerted_at FROM plan_items WHERE id = ?').get('queue-fail'),
    ).toEqual({ calendar_sync_alerted_at: new Date(NOW + 60_000).toISOString() });
  });
});
