import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { memoryKv } from './helpers/kv.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import worker from '../web/worker.js';
import { applyEvent } from '../web/api-dashboard.mjs';
import {
  checkinBoundary,
  checkinPathForStartParam,
  checkinScheduleKey,
  checkinWindow,
  checkinOpenButton,
} from '../web/core/checkin/windows.mjs';
import {
  checkinWindows,
  extendCheckin,
  checkinNoticePayload,
} from '../web/core/checkin/extensions.mjs';
import { checkinReminder } from '../web/core/checkin/catalog.mjs';
import { checkinNudgeCheck } from '../web/cron.mjs';
import { handleBrainCallback } from '../web/core/prerouter.mjs';
import { queueMiniAppNotice } from '../web/core/finance/reminders.mjs';
import { drainOutbox } from '../web/core/tg/outbox.mjs';

const prefs = {
  version: 3,
  schedule: { morning: '08:00', afternoon: '14:00', evening: '20:00', end: '02:00' },
};
const now = Date.parse('2026-10-11T15:30:00Z'); // 18:30 Kyiv
const target = { dateKey: '2026-10-11', slot: 'afternoon', key: checkinScheduleKey(prefs) };
function setup(migrated = true) {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0028_mini_app_finance.sql',
    ...(migrated ? ['0036_checkin_extensions.sql'] : []),
  ]);
  const kv = new Map([['settings', JSON.stringify({ checkin: prefs, quiet: { enabled: false } })]]);
  d1.db.exec("UPDATE finance_settings SET checkin_reminders=1 WHERE id='owner'");
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(kv),
    TELEGRAM_OWNER_USER_ID: '123',
    TELEGRAM_BOT_TOKEN: 'test-only',
    TELEGRAM_CHAT_ID: '123',
    TELEGRAM_BOT_USERNAME: 'sample_bot',
  });
  return { env, kv, d1 };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function post(env: Env, user: number, body: Record<string, unknown>) {
  const initData = await buildInitData(user, 'test-only');
  return worker.fetch(
    new Request('https://example.test/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, initData }),
    }),
    env,
    { waitUntil() {} },
  );
}

describe('check-in deadline contract', () => {
  it('reminds 90 minutes before each closing, including the previous evening', () => {
    expect(checkinReminder(689, prefs)).toBeNull();
    expect(checkinReminder(690, prefs)?.slot).toBe('morning');
    expect(checkinReminder(779, prefs)?.slot).toBe('morning');
    expect(checkinReminder(780, prefs)).toBeNull();
    expect(checkinReminder(1110, prefs)?.slot).toBe('afternoon');
    expect(checkinReminder(29, prefs)).toBeNull();
    expect(checkinReminder(30, prefs)?.slot).toBe('evening');
    expect(checkinReminder(120, prefs)).toBeNull();
  });
  it('starts a short-slot reminder at opening, not in the preceding slot', () => {
    const short = {
      schedule: { morning: '08:00', afternoon: '09:00', evening: '10:00', end: '11:00' },
    };
    expect(checkinReminder(479, short)).toBeNull();
    expect(checkinReminder(480, short)?.slot).toBe('morning');
  });
  it('uses the actual later deadline on an autumn DST fold', () => {
    expect(new Date(checkinBoundary('2026-10-25', 210)).toISOString()).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });
  it('handles a skipped spring hour without crashing the scheduler', () => {
    expect(new Date(checkinBoundary('2026-03-29', 210)).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });
  it('links select an exact date and slot but never execute extensions', () => {
    expect(checkinPathForStartParam('checkin_2026-10-11_evening')).toBe(
      '/checkin?date=2026-10-11&slot=evening',
    );
    expect(checkinPathForStartParam('checkin_2026-02-30_evening')).toBeNull();
    expect(checkinPathForStartParam('checkin_2026-10-11_extend')).toBeNull();
    expect(
      checkinOpenButton(
        workerEnv({ MINI_APP_URL: 'http://example.test' }),
        target.dateKey,
        target.slot,
        123,
      ),
    ).toBeNull();
  });
});
describe('one-time extension persistence', () => {
  it('extends only one slot, retains the global schedule and does not supply answers', async () => {
    const { env, kv, d1 } = setup();
    const before = kv.get('settings');
    const result = await extendCheckin(env, target, now);
    expect(result.ok).toBe(true);
    expect(result.window?.endAt).toBe('2026-10-11T18:00:00.000Z');
    expect(kv.get('settings')).toBe(before);
    expect(kv.has('stats')).toBe(false);
    expect(d1.db.prepare('SELECT count(*) AS n FROM checkin_extensions').get()?.n).toBe(1);
  });
  it('concurrent/repeated taps cannot compound an hour', async () => {
    const { env, d1 } = setup();
    const results = await Promise.all([
      extendCheckin(env, target, now),
      extendCheckin(env, target, now),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.alreadyExtended).sort()).toEqual([false, true]);
    expect(d1.db.prepare('SELECT count(*) AS n FROM checkin_extensions').get()?.n).toBe(1);
  });
  it('retains evening date when its extended hour crosses midnight', async () => {
    const { env } = setup();
    const evening = { ...target, slot: 'evening' };
    expect((await extendCheckin(env, evening, Date.parse('2026-10-11T22:00:00Z'))).ok).toBe(true);
    const windows = await checkinWindows(env, prefs, Date.parse('2026-10-11T23:30:00Z'));
    expect(windows.find((w) => w.slot === 'evening' && w.open)?.dateKey).toBe('2026-10-11');
    expect(windows.find((w) => w.slot === 'evening' && w.open)?.endAt).toBe(
      '2026-10-12T00:00:00.000Z',
    );
  });
  it('refuses to reopen a closed or future slot', async () => {
    const { env } = setup();
    expect((await extendCheckin(env, target, Date.parse('2026-10-11T17:00:00Z'))).ok).toBe(false);
    expect((await extendCheckin(env, { ...target, dateKey: '2026-10-12' }, now)).ok).toBe(false);
  });
  it('refuses a confirmed slot without changing it', async () => {
    const { env, kv, d1 } = setup();
    kv.set(
      'stats',
      JSON.stringify({
        checkins: { [target.dateKey]: { afternoon: { confirmed: true, energy: 4 } } },
      }),
    );
    const before = kv.get('stats');
    expect((await extendCheckin(env, target, now)).ok).toBe(false);
    expect(kv.get('stats')).toBe(before);
    expect(d1.db.prepare('SELECT count(*) AS n FROM checkin_extensions').get()?.n).toBe(0);
  });
  it('does not reuse or grant another hour after the global schedule changes', async () => {
    const { env, kv } = setup();
    await extendCheckin(env, target, now);
    const changed = { ...prefs, schedule: { ...prefs.schedule, evening: '20:30' } };
    kv.set('settings', JSON.stringify({ checkin: changed }));
    expect((await extendCheckin(env, target, now)).ok).toBe(false);
    expect(
      (await extendCheckin(env, { ...target, key: checkinScheduleKey(changed) }, now)).ok,
    ).toBe(false);
  });
  it('keeps normal slots working before the additive migration is installed', async () => {
    const { env } = setup(false);
    expect((await checkinWindows(env, prefs, now)).find((w) => w.slot === 'afternoon')?.open).toBe(
      true,
    );
    expect((await extendCheckin(env, target, now)).ok).toBe(false);
  });
});
describe('authoritative event routing', () => {
  it('accepts a chosen extended afternoon during the normal evening, and separates records', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env, kv } = setup();
    await extendCheckin(env, target, now);
    vi.setSystemTime(Date.parse('2026-10-11T17:30:00Z'));
    expect(
      await applyEvent(env, { type: 'checkin', questionVersion: 3, ...target, energy: 2 }),
    ).toMatchObject({ expired: false });
    expect(
      await applyEvent(env, {
        type: 'checkin',
        questionVersion: 3,
        dateKey: target.dateKey,
        slot: 'evening',
        energy: 4,
      }),
    ).toMatchObject({ expired: false });
    const day = JSON.parse(kv.get('stats')!).checkins[target.dateKey];
    expect(day.afternoon.energy).toBe(2);
    expect(day.evening.energy).toBe(4);
  });
  it('does not write a forged, expired or next-day target', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env, kv } = setup();
    for (const input of [
      { slot: 'morning', dateKey: target.dateKey },
      { slot: 'afternoon', dateKey: '2026-10-12' },
    ]) {
      expect(
        await applyEvent(env, { type: 'checkin', questionVersion: 3, energy: 4, ...input }),
      ).toMatchObject({ expired: true });
    }
    expect(kv.has('stats')).toBe(false);
  });
  it('records an extended evening in its original day, then rejects it after the new deadline', async () => {
    const { env, kv } = setup();
    await extendCheckin(env, { ...target, slot: 'evening' }, Date.parse('2026-10-11T22:00:00Z'));
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-11T23:30:00Z'));
    expect(
      await applyEvent(env, {
        type: 'checkin',
        questionVersion: 3,
        dateKey: target.dateKey,
        slot: 'evening',
        mood: 4,
      }),
    ).toMatchObject({ expired: false });
    expect(JSON.parse(kv.get('stats')!).checkins['2026-10-11'].evening.mood).toBe(4);
    vi.setSystemTime(Date.parse('2026-10-12T00:00:00Z'));
    expect(
      await applyEvent(env, {
        type: 'checkin',
        questionVersion: 3,
        dateKey: target.dateKey,
        slot: 'evening',
        mood: 1,
      }),
    ).toMatchObject({ expired: true });
  });
  it('requires primary-owner authorization, even for an allowed read-only co-owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env } = setup();
    env.TELEGRAM_ALLOWED_USER_IDS = '456';
    expect((await post(env, 456, { type: 'checkin_extend', ...target })).status).toBe(403);
    expect((await post(env, 123, { type: 'checkin_extend', ...target })).status).toBe(200);
    expect((await post(env, 123, { type: 'checkin_extend', ...target })).status).toBe(200);
  });
  it('exposes both overlapping open slots in authenticated stats', async () => {
    const { env } = setup();
    await extendCheckin(env, target, now);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-11T17:30:00Z'));
    const init = await buildInitData(123, 'test-only');
    const response = await worker.fetch(
      new Request('https://example.test/api/stats', { headers: { 'X-Telegram-Init-Data': init } }),
      env,
      { waitUntil() {} },
    );
    const stats = (await response.json()) as { checkinWindows: { open: boolean; slot: string }[] };
    expect(response.status).toBe(200);
    expect(stats.checkinWindows.filter((w) => w.open).map((w) => w.slot)).toEqual([
      'afternoon',
      'evening',
    ]);
  });
});
describe('notifications and callbacks', () => {
  it('queues once at 90 minutes, retries a missed tick until closing, and never pings twice after extending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now - 60000);
    const { env, d1 } = setup();
    await checkinNudgeCheck(env);
    expect(d1.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(0);
    vi.setSystemTime(now + 10 * 60000);
    await checkinNudgeCheck(env);
    await checkinNudgeCheck(env);
    expect(d1.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(1);
    await extendCheckin(env, target, now + 10 * 60000);
    vi.setSystemTime(now + 3600000);
    await checkinNudgeCheck(env);
    expect(d1.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(1);
  });
  it('respects the existing notification opt-out and quiet settings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { env, d1, kv } = setup();
    d1.db.exec('UPDATE finance_settings SET checkin_reminders=0');
    await checkinNudgeCheck(env);
    d1.db.exec('UPDATE finance_settings SET checkin_reminders=1');
    kv.set(
      'settings',
      JSON.stringify({ checkin: prefs, quiet: { enabled: true, from: '18:00', to: '21:00' } }),
    );
    await checkinNudgeCheck(env);
    expect(d1.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(0);
  });
  it('revalidates queued cards: confirmed/closed slots are not delivered', async () => {
    for (const confirmed of [true, false]) {
      const { env, kv } = setup();
      await queueMiniAppNotice(env, 'test', 'old text', now, { checkin_notice: target });
      if (confirmed)
        kv.set(
          'stats',
          JSON.stringify({ checkins: { [target.dateKey]: { afternoon: { confirmed: true } } } }),
        );
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await drainOutbox(env, {
        nowMs: confirmed ? now : Date.parse('2026-10-11T17:00:00Z'),
        sleep: async () => {},
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it('refreshes a queued card after extension and strips private service metadata', async () => {
    const { env } = setup();
    await queueMiniAppNotice(env, 'test', 'old text', now, { checkin_notice: target });
    await extendCheckin(env, target, now);
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
    vi.stubGlobal('fetch', fetch);
    await drainOutbox(env, { nowMs: now, sleep: async () => {} });
    const payload = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(payload.text).toContain('21:00');
    expect(payload).not.toHaveProperty('checkin_notice');
    expect(payload.reply_markup.inline_keyboard).toHaveLength(1);
  });
  it('does not deliver a queued nudge after its notification setting was disabled', async () => {
    const { env, d1 } = setup();
    await queueMiniAppNotice(env, 'test', 'old text', now, { checkin_notice: target });
    d1.db.exec('UPDATE finance_settings SET checkin_reminders=0');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await drainOutbox(env, { nowMs: now, sleep: async () => {} });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports a committed extension honestly when editing the Telegram card fails', async () => {
    const { env, d1 } = setup();
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })));
    vi.stubGlobal('fetch', fetch);
    const parsed = {
      data: `ci:extend:${target.dateKey}:${target.slot}:${target.key}`,
      fromId: 123,
      chatId: 123,
      messageId: 9,
    };
    expect(await handleBrainCallback(env, parsed, now)).toContain(
      'Чек-ін продовжено. Не вдалося оновити картку',
    );
    expect(await handleBrainCallback(env, parsed, now)).toBe('Уже продовжено на годину.');
    expect(d1.db.prepare('SELECT count(*) AS n FROM checkin_extensions').get()?.n).toBe(1);
  });
  it('replaces the original card, removes the extension button and refuses non-owner callbacks', async () => {
    const { env } = setup();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetch);
    const data = `ci:extend:${target.dateKey}:${target.slot}:${target.key}`;
    expect(
      await handleBrainCallback(env, { data, fromId: 456, chatId: 123, messageId: 9 }, now),
    ).toContain('власнику');
    expect(
      await handleBrainCallback(env, { data, fromId: 123, chatId: 123, messageId: 9 }, now),
    ).toBe('Продовжено на годину.');
    const payload = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(payload.message_id).toBe(9);
    expect(payload.text).toContain('21:00');
    expect(payload.reply_markup.inline_keyboard.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ callback_data: data })]),
    );
  });
  it('does not display success when persistence fails; retains the retry card', async () => {
    const { env, d1 } = setup();
    d1.db.exec(
      "CREATE TRIGGER fail_extension BEFORE INSERT ON checkin_extensions BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      await handleBrainCallback(
        env,
        {
          data: `ci:extend:${target.dateKey}:${target.slot}:${target.key}`,
          fromId: 123,
          chatId: 123,
          messageId: 9,
        },
        now,
      ),
    ).toContain('Не вдалося');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('provides buttons meaningful for this slot, not generic worker exports', () => {
    const { env } = setup();
    const card = checkinNoticePayload(
      env,
      { ...checkinWindow(target.dateKey, target.slot, prefs), extensionAvailable: true },
      123,
    );
    expect(card.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual([
      'Відкрити чек-ін',
      'Ще годину',
    ]);
  });
});
