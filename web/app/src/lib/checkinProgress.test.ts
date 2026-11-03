import { expect, it } from 'vitest';
import { EMPTY_STATS } from '../api/sample.ts';
import type { Stats } from '../api/schema.ts';
import { checkinDayProgress, checkinServerNow } from './checkinProgress.ts';

function snapshot(): Stats {
  return {
    ...EMPTY_STATS,
    checkinDate: '2026-11-03',
    checkinSlot: 'morning',
    checkinToday: null,
    checkinWindows: [
      { slot: 'morning', startAt: '2026-11-03T08:00:00+02:00', endAt: '2026-11-03T13:00:00+02:00' },
      {
        slot: 'afternoon',
        startAt: '2026-11-03T14:00:00+02:00',
        endAt: '2026-11-03T20:00:00+02:00',
      },
      { slot: 'evening', startAt: '2026-11-03T20:00:00+02:00', endAt: '2026-11-04T02:00:00+02:00' },
    ].map((w) => ({
      ...w,
      slot: w.slot as 'morning' | 'afternoon' | 'evening',
      dateKey: '2026-11-03',
      key: '1234abcd',
      baseEnd: w.endAt,
      extended: false,
      extensionAvailable: true,
      open: w.slot === 'morning',
      gapIn: 0,
    })),
  };
}
const now = Date.parse('2026-11-03T10:00:00+02:00');
it('marks only explicit confirmations; drafts and future slots never count as done', () => {
  const s = snapshot();
  s.checkinToday = { morning: { energy: 4, questionVersion: 3 } };
  let p = checkinDayProgress(s, now);
  expect(p.items.map((i) => i.state)).toEqual(['draft', 'upcoming', 'upcoming']);
  expect(p.completed).toBe(0);
  expect(p.href).toBe('/checkin?date=2026-11-03&slot=morning');
  s.checkinToday.morning!.confirmed = true;
  p = checkinDayProgress(s, now);
  expect(p.items[0]!.state).toBe('done');
  expect(p.completed).toBe(1);
  const pending = checkinDayProgress(s, now, undefined, [
    { slot: 'morning', dateKey: '2026-11-03' },
  ]);
  expect(pending.items[0]!.state).toBe('saving');
  expect(pending.completed).toBe(0);
});
it('distinguishes a closed unfinished slot from the next slot before it opens', () => {
  const s = snapshot();
  s.checkinWindows![0]!.open = false;
  s.checkinSlot = null;
  const p = checkinDayProgress(s, Date.parse('2026-11-03T13:30:00+02:00'));
  expect(p.items.map((i) => i.state)).toEqual(['closed', 'upcoming', 'upcoming']);
  expect(p.items[1]!.description).toBe('Від 14:00');
  expect(p.href).toBe('/checkin');
});
it('retains the previous evening after midnight and resets to the new day after its extension closes', () => {
  const s = snapshot();
  s.checkinSlot = null;
  s.checkinToday = {};
  s.checkinRaw = {
    ...s.checkinRaw,
    records: { '2026-11-02': { morning: { confirmed: true }, afternoon: { confirmed: true } } },
  };
  s.checkinWindows!.unshift({
    ...s.checkinWindows![2]!,
    dateKey: '2026-11-02',
    startAt: '2026-11-02T20:00:00+02:00',
    baseEnd: '2026-11-03T02:00:00+02:00',
    endAt: '2026-11-03T03:00:00+02:00',
    open: true,
    extended: true,
  });
  s.checkinWindows![1]!.open = false;
  let p = checkinDayProgress(s, Date.parse('2026-11-03T02:30:00+02:00'));
  expect(p.date).toBe('2026-11-02');
  expect(p.previousDay).toBe(true);
  expect(p.completed).toBe(2);
  expect(p.href).toBe('/checkin?date=2026-11-02&slot=evening');
  p = checkinDayProgress(s, Date.parse('2026-11-03T03:01:00+02:00'));
  expect(p.date).toBe('2026-11-03');
  expect(p.completed).toBe(0);
  expect(p.items.map((i) => i.state)).toEqual(['upcoming', 'upcoming', 'upcoming']);
});
it('reads the selected historical day, not the current-day answers, and respects custom windows', () => {
  const s = snapshot();
  s.checkinToday = {
    morning: { confirmed: true },
    afternoon: { confirmed: true },
    evening: { confirmed: true },
  };
  s.checkinRaw = { ...s.checkinRaw, records: { '2026-11-02': { evening: { confirmed: true } } } };
  expect(checkinDayProgress(s, now, '2026-11-02').completed).toBe(1);
  s.checkinToday = null;
  s.checkinWindows![0]!.startAt = '2026-11-03T11:00:00+02:00';
  const p = checkinDayProgress(s, now);
  expect(p.items[0]!.state).toBe('upcoming');
  expect(p.items[0]!.description).toBe('Від 11:00');
});
it('uses the server anchor despite phone clock drift and optimistic updatedAt changes', () => {
  const receivedAtMs = now + 86400000;
  const data = {
    stats: { ...snapshot(), checkinServerTime: new Date(now).toISOString() },
    demo: false,
    receivedAtMs,
  };
  const clock = checkinServerNow(data, receivedAtMs + 120000, receivedAtMs + 60000);
  expect(clock).toBe(now + 60000);
  expect(checkinDayProgress(data.stats, clock).date).toBe('2026-11-03');
  expect(checkinServerNow(data, receivedAtMs + 120000, receivedAtMs - 1)).toBe(now);
});
it('does not carry confirmations into a new day from a stale snapshot', () => {
  const s = snapshot();
  s.checkinToday = {
    morning: { confirmed: true },
    afternoon: { confirmed: true },
    evening: { confirmed: true },
  };
  const p = checkinDayProgress(s, Date.parse('2026-11-04T08:00:00+02:00'));
  expect(p.date).toBe('2026-11-04');
  expect(p.completed).toBe(0);
});
