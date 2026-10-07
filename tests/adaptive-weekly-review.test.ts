import { expect, it } from 'vitest';
import { weeklyReview } from '../web/core/checkin/weekly-review.mjs';
const day = (minutes: number, confirmed = true) => ({
  morning: {
    confirmed,
    questionVersion: 3,
    sleepMinutesV3: minutes,
    mood: 2,
    sleepBlockersV3: ['time'],
  },
  evening: { confirmed, questionVersion: 3, mood: 4, developmentActualV3: 'learn' },
});
it('uses a completed calendar week, confirmed observations and actual clarification denominators', () => {
  const records = {
    '2026-09-28': day(360),
    '2026-09-29': day(420),
    '2026-09-30': day(480),
    '2026-10-01': day(120, false),
  };
  const r = weeklyReview(records, '2026-10-07');
  expect(r).toMatchObject({ from: '2026-09-28', to: '2026-10-04', recordedDays: 3 });
  expect(r.items.find((x) => x.id === 'sleep')?.text).toContain('7 год за 3');
  expect(r.items.find((x) => x.id === 'sleepBlockersV3')).toMatchObject({
    n: 3,
    dates: ['2026-09-28', '2026-09-29', '2026-09-30'],
  });
  expect(r.items.find((x) => x.id === 'mood')?.text).toContain('Вищий увечері — 3');
});
it('compares the same weekdays of partial weeks instead of adjacent weekends', () => {
  const records = {
    '2026-10-05': day(420),
    '2026-10-06': day(420),
    '2026-10-07': day(420),
    '2026-09-28': day(360),
    '2026-09-29': day(360),
    '2026-09-30': day(360),
    '2026-10-04': day(720),
  };
  const r = weeklyReview(records, '2026-10-07', false);
  expect(r).toMatchObject({ days: 3, from: '2026-10-05', to: '2026-10-07' });
  expect(r.items.find((x) => x.id === 'sleep')?.text).toContain('1 год (3 записів)');
});
it('does not manufacture observations for missing, legacy or sparse data', () => {
  expect(weeklyReview({}, '2026-10-07').items).toEqual([]);
  expect(weeklyReview({ '2026-10-01': day(420) }, '2026-10-07').items).toEqual([]);
});
