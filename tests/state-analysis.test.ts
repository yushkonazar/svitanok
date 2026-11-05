import { describe, expect, it } from 'vitest';
import { adaptiveDay } from '../web/core/checkin/adaptive-observations.mjs';
import { shiftCheckinDate } from '../web/core/checkin/observations.mjs';
import {
  compareState,
  demoStateRecords,
  stateDistribution,
  stateReport,
  STATE_FACTORS,
} from '../web/core/checkin/state-analysis.mjs';

const confirmed = (fields: Record<string, unknown> = {}) => ({
  confirmed: true,
  questionVersion: 4,
  ...fields,
});
const day = (date: string, fields: Record<string, unknown> = {}) => adaptiveDay(date, fields);

describe('state statistics: observed data and comparable periods', () => {
  it('keeps absent, unknown and unconfirmed answers out of scores; an explicit sleepless night is zero', () => {
    const report = stateReport(
      {
        '2026-11-01': {
          morning: confirmed({ sleepModeV4: 'none', energy: 2, mood: 3 }),
          evening: confirmed({ satisfactionV4: 'unknown', developmentActualV4: ['unknown'] }),
        },
        '2026-11-02': {
          morning: confirmed({ sleepModeV4: 'unknown', energy: 4 }),
          evening: { confirmed: false, questionVersion: 4, energy: 1, mood: 1, satisfactionV4: 1 },
        },
        '2026-11-03': { morning: { confirmed: true, questionVersion: 2, energy: 5 } },
      },
      '2026-11-05',
      7,
    );
    expect(report.recordedDays).toBe(2);
    expect(report.overview.find((x) => x.id === 'sleep')).toMatchObject({
      value: 0,
      n: 1,
      delta: null,
    });
    expect(report.overview.find((x) => x.id === 'energy')).toMatchObject({ value: 3, n: 2 });
    expect(report.overview.find((x) => x.id === 'satisfaction')).toMatchObject({
      value: null,
      n: 0,
    });
    expect(report.learning.study).toMatchObject({ known: 0, done: 0 });
    expect(report.insights).toEqual([]);
    expect(report.current).toHaveLength(7);
  });
  it('balances times of day and refuses a baseline with different time coverage', () => {
    const records = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `2026-11-0${i + 1}`,
        {
          morning: confirmed({ energy: 5 }),
          ...(i === 0 ? { evening: confirmed({ energy: 1 }) } : {}),
        },
      ]),
    );
    const report = stateReport(records, '2026-11-07', 7);
    expect(report.overview[0]).toMatchObject({
      value: 3,
      n: 8,
      delta: null,
      slots: ['morning', 'evening'],
    });
    const withPrevious = {
      ...records,
      ...Object.fromEntries(
        [25, 26, 27, 28, 29, 30, 31].map((d) => [
          `2026-10-${d}`,
          { morning: confirmed({ energy: 2 }) },
        ]),
      ),
    };
    expect(stateReport(withPrevious, '2026-11-07', 7).overview[0]?.delta).toBeNull();
  });
  it('compares equivalent 7 day windows in scale points, with known sample sizes', () => {
    const records = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [
        `2026-11-${String(i + 1).padStart(2, '0')}`,
        { morning: confirmed({ energy: i < 7 ? 2 : 4, mood: i < 7 ? 3 : 4 }) },
      ]),
    );
    const report = stateReport(records, '2026-11-14', 7);
    expect(report.overview[0]).toMatchObject({
      value: 4,
      previous: 2,
      n: 7,
      previousN: 7,
      delta: 2,
    });
    expect(report.previousFrom).toBe('2026-11-01');
    expect(report.previousTo).toBe('2026-11-07');
    expect(report.insights.find((item) => item.id === 'mood-change')).toMatchObject({
      n: 7,
      kind: 'observation',
    });
  });
  it('counts lower evening energy only on paired days and explains the actual dates', () => {
    const records: Record<string, Record<string, unknown>> = Object.fromEntries(
      [1, 2, 3].map((i) => [
        `2026-11-0${i}`,
        { morning: confirmed({ energy: 4 }), evening: confirmed({ energy: 2 }) },
      ]),
    );
    records['2026-11-04'] = { morning: confirmed({ energy: 1 }) };
    const insight = stateReport(records, '2026-11-05', 7).insights.find(
      (x) => x.id === 'daily-energy',
    );
    expect(insight).toMatchObject({
      n: 3,
      kind: 'observation',
      dates: ['2026-11-01', '2026-11-02', '2026-11-03'],
    });
  });
  it('separates explicit absence of learning from unknown and keeps old combined learning separate', () => {
    const report = stateReport(
      {
        '2026-11-01': {
          morning: confirmed({ developmentPlanV4: ['study', 'course'] }),
          evening: confirmed({ developmentActualV4: ['study'] }),
        },
        '2026-11-02': { evening: confirmed({ developmentActualV4: ['none'] }) },
        '2026-11-03': { evening: confirmed({ developmentActualV4: ['unknown'] }) },
        '2026-11-04': { evening: confirmed({ questionVersion: 3, developmentActualV3: 'learn' }) },
      },
      '2026-11-05',
      7,
    );
    expect(report.learning.study).toMatchObject({
      done: 1,
      known: 2,
      planned: 1,
      observed: 1,
      met: 1,
    });
    expect(report.learning.course).toMatchObject({
      done: 0,
      known: 2,
      planned: 1,
      observed: 1,
      met: 0,
    });
    expect(report.legacyLearning).toBe(1);
  });
});
describe('independent comparisons and historical labels', () => {
  it('compares paired work days within a duration and refuses a lead based on mixed shifts', () => {
    const to = '2026-11-05';
    const shifts = [
      { hours: '4_8h', breaks: 'none', morning: 5, evening: 2, n: 12 },
      { hours: '4_8h', breaks: 'enough', morning: 5, evening: 1, n: 6 },
      { hours: '8_12h', breaks: 'none', morning: 1, evening: 5, n: 6 },
      { hours: '8_12h', breaks: 'enough', morning: 1, evening: 4, n: 12 },
    ];
    let offset = 0;
    const records = Object.fromEntries(
      shifts.flatMap((shift) =>
        Array.from({ length: shift.n }, () => [
          shiftCheckinDate(to, -offset++),
          {
            morning: confirmed({ energy: shift.morning }),
            evening: confirmed({
              energy: shift.evening,
              workRangeV4: shift.hours,
              workBreaksV4: shift.breaks,
            }),
          },
        ]),
      ),
    );
    const report = stateReport(records, to, 90);
    expect(compareState(report.current, 'work_breaks', 'energy_change').delta).toBeGreaterThan(1);
    for (const workRange of ['4_8h', '8_12h']) {
      const result = compareState(report.current, 'work_breaks', 'energy_change', { workRange });
      expect(result).toMatchObject({ ready: true, delta: -1 });
    }
    expect(report.insights.some((insight) => insight.id === 'work_breaks')).toBe(false);
  });

  it('cannot use gated mood reasons or unmarked activities as independent factors', () => {
    expect(STATE_FACTORS.some(([, id]) => /moodFactors|activities|energyFactors/.test(id))).toBe(
      false,
    );
    const rows = [
      day('2026-11-01', {
        evening: confirmed({ mood: 5, moodFactorsV4: ['weather_good'], activitiesV4: ['walk'] }),
      }),
    ];
    expect(compareState(rows, 'moodFactorsV4', 'evening_mood')).toMatchObject({
      ready: false,
      delta: null,
    });
    expect(compareState(rows, 'activities', 'evening_mood').groups.every((g) => g.n === 0)).toBe(
      true,
    );
  });
  it('shows an insufficient comparison without inventing a finding', () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      day(`2026-11-0${i}`, {
        evening: confirmed({ energy: i <= 2 ? 2 : 4, workBreaksV4: i <= 2 ? 'none' : 'enough' }),
      }),
    );
    const result = compareState(rows, 'work_breaks', 'evening_energy');
    expect(result.groups.map((g) => g.n)).toEqual([2, 3]);
    expect(result.ready).toBe(false);
    expect(result.delta).toBeNull();
  });
  it('uses explicit work breaks, excludes not applicable and unknown, and pairs energy change', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      day(`2026-11-0${i + 1}`, {
        morning: i === 0 ? {} : confirmed({ energy: 4 }),
        evening: confirmed({
          energy: i < 3 ? 1 : 3,
          workBreaksV4: i < 3 ? 'not_enough' : i < 6 ? 'enough' : i === 6 ? 'na' : 'unknown',
        }),
      }),
    );
    const direct = compareState(rows, 'work_breaks', 'evening_energy');
    expect(direct).toMatchObject({ ready: true, delta: 2 });
    expect(direct.groups.map((g) => g.n)).toEqual([3, 3]);
    const paired = compareState(rows, 'work_breaks', 'energy_change');
    expect(paired.groups.map((g) => g.n)).toEqual([2, 3]);
    expect(paired.ready).toBe(false);
  });
  it('splits sleep at the observed personal median and retains zero sleep', () => {
    const rows = [0, 4, 5, 6, 7, 8].map((hours, i) =>
      day(`2026-11-0${i + 1}`, {
        morning: confirmed({
          energy: i < 3 ? 2 : 4,
          sleepModeV4: hours ? 'main' : 'none',
          sleepMinutesV4: hours ? hours * 60 : undefined,
        }),
      }),
    );
    const result = compareState(rows, 'sleep_duration', 'morning_energy');
    expect(result).toMatchObject({ median: 5.5, ready: true, delta: 2 });
    expect(result.groups.map((g) => g.n)).toEqual([3, 3]);
  });
  it('does not mix changed sleep quality wording or an unrelated practice outcome', () => {
    const rows = [
      day('2026-11-01', {
        morning: confirmed({ questionVersion: 3, sleepQualityV3: 1, energy: 2 }),
        evening: confirmed({ coursePracticeV4: 'self', energy: 5 }),
      }),
    ];
    expect(
      compareState(rows, 'sleep_quality', 'morning_energy').groups.every((g) => g.n === 0),
    ).toBe(true);
    expect(
      compareState(rows, 'course_practice', 'evening_energy').groups.every((g) => g.n === 0),
    ).toBe(true);
  });
  it('uses explicit alone and a saved custom company label, only since its first mention', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      day(`2026-11-0${i}`, {
        evening: confirmed({
          mood: i % 2 ? 2 : 5,
          companyV4: i % 2 ? ['alone'] : i === 2 ? ['friends'] : ['user_team'],
          optionLabelsV4: { companyV4: { user_team: 'Люди :: Моя команда' } },
        }),
      }),
    );
    const result = compareState(rows, 'company', 'evening_mood', { company: 'user_team' });
    expect(result.from).toBe('2026-11-04');
    expect(result.groups[0]?.dates).toEqual(['2026-11-05', '2026-11-07']);
    expect(result.groups[1]).toMatchObject({ label: 'Моя команда', n: 3 });
  });
  it('keeps a denominator for the question actually answered, preserving custom snapshots', () => {
    const rows = [
      day('2026-11-01', {
        evening: confirmed({
          moodFactorsV4: ['user_love', 'weather_good'],
          optionLabelsV4: { moodFactorsV4: { user_love: 'Люди :: Побачення' } },
        }),
      }),
      day('2026-11-02', { evening: confirmed({ mood: 4 }) }),
    ];
    const distribution = stateDistribution(rows, 'evening', 'moodFactors');
    expect(distribution.n).toBe(1);
    expect(distribution.items.find((x) => x.id === 'user_love')).toMatchObject({
      label: 'Побачення',
      count: 1,
      dates: ['2026-11-01'],
    });
  });
  it('keeps the richer demo explicit and the private empty report empty', () => {
    expect(stateReport(demoStateRecords('2026-11-05'), '2026-11-05').recordedDays).toBe(30);
    expect(stateReport({}, '2026-11-05').recordedDays).toBe(0);
  });
});
