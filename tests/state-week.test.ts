import { describe, expect, it } from 'vitest';
import { adaptiveDay } from '../web/core/checkin/adaptive-observations.mjs';
import { CHECKIN_FLOW_REVISION } from '../web/core/checkin/state-ratings.mjs';
import { stateWeek } from '../web/core/checkin/state-week.mjs';
import { weeklyPersonalPeriods } from '../web/core/brain/weekly-personal.mjs';
import { reportPeriod } from '../web/core/report-period.mjs';
import { weeklySummary } from '../web/core/tools/weekly-summary.mjs';
import { interpretWeeklyReport } from '../web/core/brain/weekly-interpretation.mjs';
import { weeklyFactDecision } from '../web/core/brain/weekly-report-format.mjs';

const dates = ['02', '03', '04', '05', '06', '07', '08'].map((day) => `2026-11-${day}`);
const confirmed = { questionVersion: 4, confirmed: true };
const revised = { ...confirmed, flowRevisionV4: CHECKIN_FLOW_REVISION };
const days = (records: Record<string, unknown>[]) =>
  dates.map((date, i) => adaptiveDay(date, records[i] ?? {}));

describe('seven-day state overview', () => {
  it('reports shorter nights, keeps gaps distinct from no sleep, and excludes naps and drafts', () => {
    const morning = (sleepMinutesV4: number) => ({
      ...confirmed,
      sleepModeV4: 'main',
      sleepMinutesV4,
    });
    const { focus, signals } = stateWeek(
      days([
        { morning: morning(480) },
        { morning: morning(450) },
        { morning: { ...morning(45), sleepModeV4: 'naps' } },
        { morning: { ...morning(570), confirmed: false } },
        { morning: morning(360) },
        { morning: morning(330) },
        { morning: { ...confirmed, sleepModeV4: 'none' } },
      ]),
    );
    expect(focus).toBe('sleep');
    expect(signals.sleep.title).toBe('Сон скоротився');
    expect(signals.sleep.text).toContain('Менше 7 год · 3 із 5 ночей');
    expect(signals.sleep.points.map((point) => point.value)).toEqual([
      480,
      450,
      null,
      null,
      360,
      330,
      0,
    ]);
  });
  it('compares the same slot across the week and plots mixed scales in shared bands', () => {
    const { signals } = stateWeek(
      days(
        dates.map((_, i) => ({
          morning: { ...revised, moodLevelV4: 8 },
          evening:
            i < 3
              ? { ...confirmed, mood: 4 }
              : { ...revised, moodLevelV4: 2, moodFactorsV4: ['fatigue'] },
        })),
      ),
    );
    expect(signals.mood).toMatchObject({
      title: 'Настрій увечері погіршився',
      slot: 'evening',
      max: 3,
      samples: 7,
    });
    expect(signals.mood.points.map((point) => point.value)).toEqual([3, 3, 3, 1, 1, 1, 1]);
    expect(signals.mood.context).toEqual([
      expect.objectContaining({ kind: 'reported', dates: dates.slice(3) }),
    ]);
    const sparse = stateWeek(
      days([
        { evening: { ...revised, moodLevelV4: 8 } },
        { morning: { ...revised, moodLevelV4: 2 } },
      ]),
    );
    expect(sparse.signals.mood.title).toBe('Настрій увечері');
  });
  it('only associates the previous evening with the next morning when calendar times agree', () => {
    const returnHome = { ...revised, homeArrivalStatusV4: 'next', homeArrivalTimeV4: '00:30' };
    const morning = {
      ...revised,
      sleepModeV4: 'main',
      sleepMinutesV4: 330,
      sleepBedtimeDayV4: 'same',
      sleepBedtimeV4: '01:20',
      sleepWakeV4: '06:50',
      moodLevelV4: 3,
      sleepBlockersV4: ['late_home'],
    };
    const input = [
      { evening: returnHome },
      { morning, evening: returnHome },
      { morning, evening: returnHome },
      { morning: { ...morning, sleepBedtimeDayV4: 'previous' } },
    ];
    const context = stateWeek(days(input)).signals.sleep.context;
    expect(context).toMatchObject([
      {
        kind: 'observed',
        dates: dates.slice(1, 3),
        examples: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('00:30 · ліг о 01:20') }),
        ]),
      },
      { kind: 'reported', dates: dates.slice(1, 4) },
    ]);
    expect(context[0]?.idea).toBeUndefined();
  });
  it('compares recorded sleep groups and actual course days, leaving unknown participation out', () => {
    const week = stateWeek(
      days(
        dates.map((_, i) => ({
          morning: {
            ...revised,
            sleepModeV4: 'main',
            sleepMinutesV4: i < 3 ? 320 : 450,
            moodLevelV4: i < 3 ? 3 : 7,
          },
          evening: {
            ...revised,
            moodLevelV4: i < 3 ? 7 : 3,
            developmentActualV4: i < 3 ? ['course'] : i === 6 ? ['unknown'] : ['none'],
          },
        })),
      ),
    );
    expect(week.signals.sleep.context).toMatchObject([
      {
        kind: 'observed',
        text: expect.stringContaining('настрій зранку частіше був складнішим'),
        dates,
      },
    ]);
    expect(week.signals.mood.context).toMatchObject([
      {
        kind: 'observed',
        text: expect.stringContaining('У дні з курсом'),
        dates: dates.slice(0, 6),
      },
    ]);
  });
  it('keeps a completed replacement separate from finishing the original plan', () => {
    const record = {
      morning: { ...confirmed, priorityV4: 'work' },
      evening: { ...confirmed, priorityOutcomeV4: 'finished' },
    };
    const { signals } = stateWeek(
      days([
        record,
        { ...record, afternoon: { ...confirmed, priorityPaceV4: 'changed' } },
        { ...record, morning: { ...record.morning, priorityV4: 'noplan' } },
      ]),
    );
    expect(signals.plans.points.map((point) => point.value)).toEqual([
      3,
      1,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(signals.plans.text).toContain('Головне завершено у 1 з 2');
  });
  it('keeps the same sleep finding in the saved report and respects the cutoff', () => {
    const asOf = Date.parse('2026-11-08T13:00:00Z');
    const records = dates.map((date, i) => ({
      morning: {
        ...confirmed,
        sleepModeV4: 'main',
        sleepMinutesV4: [480, 450, 450, 350, 350, 360, 620][i],
        confirmedAtV3: `${date}T${i === 6 ? '14:00' : '06:00'}:00Z`,
      },
    }));
    const periods = weeklyPersonalPeriods(
      Object.fromEntries(dates.map((date, i) => [date, records[i]])),
      asOf,
      reportPeriod(dates[0]!, dates[6]!, asOf),
    );
    const expected = stateWeek(days(records.slice(0, 6))).highlights[0]!;
    const summary = weeklySummary({ personalPeriods: periods });
    expect(summary.personalPeriods?.current?.weekHighlights?.[0]).toMatchObject(expected);
    expect(expected.dates).not.toContain(dates[6]);
    expect(interpretWeeklyReport(summary).sections[0]).toMatchObject({
      kind: 'personal',
      title: expected.title,
      paragraphs: [expected.text],
    });
    expect(weeklyFactDecision(summary).highlights).toContainEqual({
      kind: 'personal',
      text: `${expected.title}. ${expected.text}`,
    });
  });
});
