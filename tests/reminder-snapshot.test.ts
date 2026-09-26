import { describe, expect, it, vi } from 'vitest';
import {
  mergeBriefReminders,
  parseReminderSnapshot,
  refreshBriefReminders,
  REMINDER_SNAPSHOT_KEY,
} from '../web/core/brief/reminder-snapshot.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const TODAY = '2026-09-08';
const NOW = Date.parse('2026-09-08T04:30:00.000Z'); // 07:30 Київ
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0010_reminders_address.sql',
  '0012_reminders_recurrence.sql',
];

describe('brief reminder snapshot', () => {
  it('merges both stores by id, keeps overdue/today items and rejects future ones', () => {
    const reminders = mergeBriefReminders(
      [
        { id: 'same', text: 'старий текст', whenMs: Date.parse('2026-09-08T05:00:00.000Z') },
        { id: 'legacy', text: 'прострочене', whenMs: Date.parse('2026-09-07T08:00:00.000Z') },
        { id: 'future', text: 'завтра', whenMs: Date.parse('2026-09-09T08:00:00.000Z') },
      ],
      [
        { id: 'same', text: 'канонічний текст', dueAt: '2026-09-08T05:00:00.000Z' },
        { id: 'd1', text: 'сьогодні', dueAt: '2026-09-08T10:00:00.000Z' },
      ],
      TODAY,
    );
    expect(reminders.map((r) => [r.id, r.text])).toEqual([
      ['legacy', 'прострочене'],
      ['same', 'канонічний текст'],
      ['d1', 'сьогодні'],
    ]);
  });

  it('parses only a bounded usable snapshot', () => {
    expect(
      parseReminderSnapshot({
        date: TODAY,
        ready: true,
        updatedAt: '2026-09-08T04:30:00.000Z',
        source: 'd1',
        reminders: [
          { id: 'ok', text: 'x', dueAt: '2026-09-08T05:00:00.000Z' },
          { id: 'bad', text: 'x', dueAt: 'not-a-date' },
        ],
      }),
    ).toMatchObject({ date: TODAY, source: 'd1', reminders: [{ id: 'ok' }] });
  });

  it('writes the D1-backed state snapshot before dispatch time', async () => {
    const d1 = d1FromSqlite(MIGRATIONS);
    d1.db
      .prepare(
        "INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?, ?, ?, 'pending', 0)",
      )
      .run('d1-today', '2026-09-08T06:00:00.000Z', 'Подати CV');
    const state = new Map<string, string>();
    state.set('state', JSON.stringify({ reminders: [] }));
    const env = workerEnv({ DB: d1.stub, BRIEFING: memoryKv(state) });

    await expect(refreshBriefReminders(env, NOW)).resolves.toMatchObject({
      written: 1,
      source: 'd1',
    });
    const saved = JSON.parse(state.get('state') ?? '{}')[REMINDER_SNAPSHOT_KEY];
    expect(saved).toMatchObject({
      date: TODAY,
      ready: true,
      source: 'd1',
      reminders: [{ id: 'd1-today', text: 'Подати CV' }],
    });
  });

  it('does not present legacy-only data as complete after the D1 production flip', async () => {
    const state = new Map<string, string>();
    state.set(
      'state',
      JSON.stringify({
        reminders: [{ id: 'legacy', text: 'Не вигадувати повноту', whenMs: NOW + 60_000 }],
      }),
    );
    const env = workerEnv({ ASSISTANT_V2: 'on', BRIEFING: memoryKv(state) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshBriefReminders(env, NOW)).resolves.toEqual({ skipped: 'd1-unavailable' });
    const saved = JSON.parse(state.get('state') ?? '{}')[REMINDER_SNAPSHOT_KEY];
    expect(saved).toMatchObject({ date: TODAY, ready: false, reminders: [], source: 'legacy' });
    error.mockRestore();
  });
});
