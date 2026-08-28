// Кнопки під нагадуванням із D1 (ревʼю PR-7). Нагадування нового шляху
// приходить із тими самими кнопками, що й легасі, а обробники читали ЛИШЕ KV -
// власник тиснув «відкласти» на щойно надісланому і діставав «неактуальне».
// Тут перевіряється, що всі три кнопки працюють для D1-записів.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveReminderSnooze,
  resolveReminderSnoozePreset,
  resolveReminderCancel,
  resolveReminderDone,
} from '../web/callbacks.mjs';
import { getReminder } from '../web/core/reminders/store.mjs';
import { SNOOZE_MINUTES, SNOOZE_PRESETS } from '../web/reminders-core.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-08-28T09:00:00.000Z');
const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0010_reminders_address.sql'];

/** Нагадування, яке ВЖЕ надіслане з D1 - саме на такому живуть кнопки. */
function makeEnv(status = 'sent') {
  const d1 = d1FromSqlite(MIGRATIONS);
  d1.db
    .prepare(
      `INSERT INTO reminders (id, due_at, text, status, snooze_count) VALUES (?, ?, ?, ?, 0)`,
    )
    .run('d1r', new Date(NOW - 60_000).toISOString(), 'полити квіти', status);
  const kv = new Map<string, string>();
  kv.set('state', JSON.stringify({ reminders: [] })); // у KV цього id немає
  return {
    d1,
    env: workerEnv({ DB: d1.stub, BRIEFING: memoryKv(kv), TELEGRAM_BOT_TOKEN: 'bot' }),
  };
}

const parsed = {
  chatId: 555,
  messageId: 7,
  data: 'rs:0:d1r',
  replyMarkup: { inline_keyboard: [[{ text: '😴', callback_data: 'rs:0:d1r' }]] },
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('кнопки D1-нагадування', () => {
  it('«відкласти» (rm:) переносить час і ставить snoozed', async () => {
    const { d1, env } = makeEnv();
    const toast = await resolveReminderSnooze(env, parsed, 'd1r');

    expect(toast).toContain('Відкладено');
    const row = await getReminder(env, 'd1r');
    expect(row).toMatchObject({ status: 'snoozed', snoozeCount: 1 });
    // Час зсунувся приблизно на SNOOZE_MINUTES від «зараз».
    const shift = Date.parse(row!.dueAt) - Date.now();
    expect(shift).toBeGreaterThan((SNOOZE_MINUTES - 1) * 60_000);
    expect(d1).toBeDefined();
  });

  it('пресет (rs:) бере хвилини саме того пресета', async () => {
    const { env } = makeEnv();
    const idx = SNOOZE_PRESETS.length - 1;
    await resolveReminderSnoozePreset(env, parsed, idx, 'd1r');
    const row = await getReminder(env, 'd1r');
    const shift = Date.parse(row!.dueAt) - Date.now();
    expect(shift).toBeGreaterThan((SNOOZE_PRESETS[idx]!.minutes - 1) * 60_000);
  });

  it('«скасувати» (rc:) ставить cancelled - кнопка живе у списку АКТИВНИХ', async () => {
    // rc: приходить зі списку /reminders, тобто з нагадування, що ще не
    // спрацювало; надіслане скасовувати нема сенсу - воно вже прийшло.
    const { env } = makeEnv('pending');
    const toast = await resolveReminderCancel(env, parsed, 'd1r');
    expect(toast).toContain('скасовано');
    expect((await getReminder(env, 'd1r'))!.status).toBe('cancelled');
  });

  it('надіслане не «скасовується» заднім числом', async () => {
    const { env } = makeEnv('sent');
    expect(await resolveReminderCancel(env, parsed, 'd1r')).toContain('неактуальне');
    expect((await getReminder(env, 'd1r'))!.status).toBe('sent');
  });

  it('«виконано» (rk:) ставить done і показує текст нагадування', async () => {
    const { env } = makeEnv();
    const toast = await resolveReminderDone(env, parsed, 'd1r');
    expect(String(toast)).not.toContain('неактуальне');
    expect((await getReminder(env, 'd1r'))!.status).toBe('done');
  });

  it('невідомий id - чесне «неактуальне», без винятку', async () => {
    const { env } = makeEnv();
    expect(await resolveReminderSnooze(env, parsed, 'нема')).toContain('неактуальне');
    expect(await resolveReminderDone(env, parsed, 'нема')).toContain('неактуальне');
  });

  it('без привʼязки DB поведінка як раніше - «неактуальне»', async () => {
    const kv = new Map<string, string>();
    kv.set('state', JSON.stringify({ reminders: [] }));
    const env = workerEnv({ BRIEFING: memoryKv(kv), TELEGRAM_BOT_TOKEN: 'bot' });
    expect(await resolveReminderCancel(env, parsed, 'd1r')).toContain('неактуальне');
  });
});
