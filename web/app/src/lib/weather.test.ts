import { expect, it } from 'vitest';
import { forecastTime } from './weather.ts';

it('labels the forecast day in Kyiv across midnight without guessing dates for old snapshots', () => {
  const now = Date.parse('2026-11-02T21:30:00Z');
  expect(forecastTime({ h: 23, at: Date.parse('2026-11-02T21:00:00Z') / 1000 }, now)).toBe(
    'сьогодні о 23:00',
  );
  expect(forecastTime({ h: 0, at: Date.parse('2026-11-02T22:00:00Z') / 1000 }, now)).toBe(
    'завтра о 00:00',
  );
  expect(forecastTime({ h: 24 }, now)).toBe('о 00:00');
});
