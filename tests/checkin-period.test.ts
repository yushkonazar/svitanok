import { describe, expect, it } from 'vitest';
import { buildCheckinPeriod } from '../web/core/tools/checkin-period.mjs';

describe('period check-in aggregates', () => {
  it('keeps absent sleep unknown, explicit sleepless night zero, and previous period separate', () => {
    const report = buildCheckinPeriod(
      {
        '2026-09-26': { morning: { sleepKind: 'slept', sleepH: 8 }, evening: { dayScore: 4 } },
        '2026-09-27': { morning: { sleepKind: 'none' }, evening: { dayScore: 2 } },
        '2026-09-28': { morning: { sleepKind: 'naps' }, evening: { dayScore: 3 } },
        '2026-09-29': { morning: { sleepKind: 'slept', sleepH: 7 }, evening: { dayScore: 5 } },
      },
      '2026-09-29',
      3,
    );
    expect(report.current).toMatchObject({
      from: '2026-09-27',
      recordedDays: 3,
      sleeplessNights: 1,
      napsWithoutDuration: 1,
      sleepHours: { n: 2, average: 3.5 },
      pairedSleepAndDayScore: 2,
      sleepDayCorrelation: null,
    });
    expect(report.previous).toMatchObject({
      to: '2026-09-26',
      recordedDays: 1,
      missingDays: 2,
      sleepHours: { n: 1, average: 8 },
    });
  });
});
