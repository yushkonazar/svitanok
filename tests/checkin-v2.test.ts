import { describe, expect, it } from 'vitest';
import {
  recordEvent,
  emptyStore,
  aggregateStats,
  isCheckinSlotFilled,
} from '../web/stats-core.mjs';
import {
  CHECKIN_CARDS,
  cleanCheckinV2,
  clearHiddenV2,
  fieldVisible,
  coreCompleteV2,
  normalizeCheckinPreferences,
  checkinClock,
  checkinReminder,
  validSchedule,
} from '../web/core/checkin/catalog.mjs';
import {
  analyzeObservations,
  observationDay,
  compareObservedFactor,
  clockRegularity,
  demoObservations,
} from '../web/core/checkin/observations.mjs';
import { statsSchema } from '../web/app/src/api/schema.ts';
import { normalizeSettings } from '../web/settings-core.mjs';
import { buildCheckinPeriod } from '../web/core/tools/checkin-period.mjs';
import { monthlyRollup, weeklyRollup } from '../web/stats-archive.mjs';

const date = '2026-10-04',
  iso = '2026-10-04T08:01:00.000Z';
const morning = {
  questionVersion: 2,
  sleepModeV2: 'main',
  sleepMinutesV2: 450,
  sleepPrecisionV2: 'approx',
  sleepQualityV2: 4,
  energy: 4,
  mood: 3,
  priorityV2: 'mate',
};
const evening = {
  questionVersion: 2,
  energy: 2,
  mood: 4,
  satisfactionV2: 4,
  priorityOutcomeV2: 'progress',
  activitiesV2: ['mate', 'taxi'],
  movementRangeV2: '16_30',
};
const event = (slot: string, answers: Record<string, unknown>) => ({
  type: 'checkin',
  slot,
  ...answers,
});
describe('check-in v2: explicit observations and preserved history', () => {
  it('has only 4/2/5 core cards and all six optional modules', () => {
    expect(
      ['morning', 'afternoon', 'evening'].map(
        (slot) => CHECKIN_CARDS[slot]!.filter((c) => !c.module).length,
      ),
    ).toEqual([4, 2, 5]);
    expect(
      new Set(
        Object.values(CHECKIN_CARDS)
          .flat()
          .map((c) => c.module)
          .filter(Boolean),
      ).size,
    ).toBe(6);
    expect(
      Object.values(CHECKIN_CARDS)
        .flat()
        .flatMap((c) => c.fields)
        .some((f) => f.id === 'jobProgress'),
    ).toBe(false);
  });
  it('rejects invalid calendar dates and permits additional custom priorities', () => {
    expect(
      cleanCheckinV2('morning', {
        sleepWakeV2: '2026-02-31T08:00',
        sleepAttemptV2: '2026-10-04T23:30',
      }).set,
    ).toEqual({ sleepAttemptV2: '2026-10-04T23:30' });
    const extra = CHECKIN_CARDS.morning!.flatMap((c) => c.fields).find(
      (f) => f.id === 'extraPriorityV2',
    )!;
    expect(fieldVisible(extra, { priorityV2: 'custom_music' })).toBe(true);
    expect(fieldVisible(extra, { priorityV2: 'noplan' })).toBe(false);
    expect(cleanCheckinV2('evening', { activitiesV2: ['noplan'] }).set).toEqual({});
  });
  it('keeps exact movement minutes and the range consistent, and counts groups once per day', () => {
    expect(clearHiddenV2('evening', { movementRangeV2: '0', movementMinutesV2: 75 })).toMatchObject(
      { movementRangeV2: 'gt60', movementMinutesV2: 75 },
    );
    const a = analyzeObservations(
      {
        [date]: {
          evening: {
            ...evening,
            confirmed: true,
            activitiesV2: ['mate', 'learn', 'custom_music'],
            activityGroupsV2: { custom_music: 'Відновлення' },
          },
        },
      },
      date,
      7,
    );
    expect(a.activityGroups['Відновлення']).toBe(1);
    expect(Object.values(a.activityGroups)).toEqual([1, 1]);
  });
  it('does not fill mood by choosing energy; partial core cannot be confirmed', () => {
    const s = recordEvent(
      emptyStore(),
      event('morning', { questionVersion: 2, energy: 4, confirmed: true }),
      date,
      null,
      iso,
    );
    expect(s.checkins[date]).toBeUndefined();
    expect(coreCompleteV2('morning', { ...morning, mood: null })).toBe(false);
  });
  it('drafts do not suppress reminders; confirmed complete core is immutable', () => {
    let s = recordEvent(emptyStore(), event('morning', morning), date, null, iso);
    expect(isCheckinSlotFilled(s.checkins[date], 'morning')).toBe(false);
    s = recordEvent(s, event('morning', { questionVersion: 2, confirmed: true }), date, null, iso);
    expect(isCheckinSlotFilled(s.checkins[date], 'morning')).toBe(true);
    const before = JSON.stringify(s.checkins);
    s = recordEvent(s, event('morning', { questionVersion: 2, energy: 1 }), date, null, iso);
    expect(JSON.stringify(s.checkins)).toBe(before);
  });
  it('records per-answer time without moving unchanged answers to the latest time', () => {
    let s = recordEvent(emptyStore(), event('morning', morning), date, null, iso);
    s = recordEvent(
      s,
      event('morning', { ...morning, mood: 5 }),
      date,
      null,
      '2026-10-04T08:05:00.000Z',
    );
    const m = s.checkins[date].morning;
    expect(m.answerTimesV2.energy).toBe(iso);
    expect(m.answerTimesV2.mood).toBe('2026-10-04T08:05:00.000Z');
    expect(m.timezoneV2).toBe('Europe/Kyiv');
  });
  it('no sleep has no quality/duration and naps require actual duration', () => {
    let s = recordEvent(emptyStore(), event('morning', morning), date);
    s = recordEvent(
      s,
      event('morning', { questionVersion: 2, sleepModeV2: 'none', confirmed: true }),
      date,
    );
    expect(s.checkins[date].morning.sleepQualityV2).toBeUndefined();
    const day = observationDay(date, s.checkins[date]);
    expect(day.sleepHours).toBe(0);
    expect(day.sleepQuality).toBeNull();
    expect(
      coreCompleteV2('morning', { ...morning, sleepModeV2: 'naps', sleepMinutesV2: null }),
    ).toBe(false);
    expect(coreCompleteV2('morning', { ...morning, sleepModeV2: 'main', sleepMinutesV2: 0 })).toBe(
      false,
    );
    expect(
      observationDay(date, {
        morning: { questionVersion: 2, confirmed: true, sleepModeV2: 'naps' },
      }).sleepHours,
    ).toBeNull();
  });
  it('rejects contradictory/too many multiple answers without silently evicting earlier values', () => {
    const cleaned = cleanCheckinV2('evening', {
      questionVersion: 2,
      blockersV2: ['none', 'fatigue'],
      helpersV2: ['rest', 'nextstep', 'music'],
      activitiesV2: ['taxi', 'taxi'],
      learningMinutesV2: -1,
    });
    expect(cleaned.set).toEqual({ questionVersion: 2 });
    expect(cleanCheckinV2('evening', { helpersV2: ['unknown'] }).set.helpersV2).toEqual([
      'unknown',
    ]);
    expect(cleanCheckinV2('evening', { helpersV2: [] }).clear).toContain('helpersV2');
  });
  it('clears hidden learning and nap details, preserves legitimate zero values', () => {
    let s = recordEvent(
      emptyStore(),
      event('evening', {
        ...evening,
        learningMinutesV2: 60,
        comprehensionV2: 5,
        extraNapV2: 'yes',
        napMinutesV2: 20,
        napStartV2: '2026-10-04T15:00',
      }),
      date,
    );
    s = recordEvent(
      s,
      event('evening', {
        questionVersion: 2,
        learningMinutesV2: 0,
        extraNapV2: 'no',
        tensionV2: 0,
        confirmed: true,
      }),
      date,
    );
    const e = s.checkins[date].evening;
    expect(e.learningMinutesV2).toBe(0);
    expect(e.tensionV2).toBe(0);
    expect(e.comprehensionV2).toBeUndefined();
    expect(e.napMinutesV2).toBeUndefined();
    expect(e.napStartV2).toBeUndefined();
  });
  it('opening never creates sleep answers or waking; previous answers are preserved', () => {
    const initial = emptyStore();
    initial.checkins['2026-10-03'] = { evening: { dayScore: 4, jobProgress: 3 } };
    let s = recordEvent(
      initial,
      { type: 'sleepStart' },
      '2026-10-03',
      null,
      '2026-10-03T20:00:00Z',
    );
    s = recordEvent(s, { type: 'open' }, date, 30, iso);
    expect(s.sleepLog['2026-10-03'].firstOpenedAfterAt).toBe(iso);
    expect(s.sleepLog['2026-10-03'].wokeAt).toBeUndefined();
    expect(s.checkins[date]).toBeUndefined();
    expect(s.checkins['2026-10-03'].evening).toEqual({ dayScore: 4, jobProgress: 3 });
  });
  it('API round-trips every valid catalog field, metadata and bounded reflections', () => {
    const s = recordEvent(
      emptyStore(),
      event('evening', {
        ...evening,
        confirmed: true,
        learningMinutesV2: 90,
        comprehensionV2: 'na',
        focusV2: 'na',
        blockersV2: ['none'],
        helpersV2: ['rest'],
        momentNoteV2: 'Моя нотатка',
      }),
      date,
      null,
      iso,
    );
    const reflected = recordEvent(
      s,
      {
        type: 'checkin_reflection',
        help: ' Сон ',
        change: 'Менше поспіху',
        step: 'Одна прогулянка',
      },
      date,
    );
    const parsed = statsSchema.parse(aggregateStats(reflected, date));
    expect(parsed.checkinToday?.evening?.learningMinutesV2).toBe(90);
    expect(parsed.checkinToday?.evening?.comprehensionV2).toBe('na');
    expect(parsed.checkinToday?.evening?.answerTimesV2?.momentNoteV2).toBe(iso);
    expect(parsed.checkinReflections?.[date]?.help).toBe('Сон');
    const fields = new Set(Object.keys(parsed.checkinToday?.evening ?? {}));
    for (const c of CHECKIN_CARDS.evening!)
      for (const f of c.fields) {
        const value =
          f.type === 'duration' || f.type === 'number'
            ? 1
            : f.type === 'datetime'
              ? '2026-10-04T10:00'
              : f.type === 'time'
                ? '10:00'
                : f.type === 'text'
                  ? 'Note'
                  : f.type === 'categories'
                    ? f.limit === 1
                      ? 'mate'
                      : ['mate']
                    : f.type === 'multi'
                      ? [f.options![0]![1]]
                      : f.options![0]![1];
        const raw = statsSchema.parse({
          ...aggregateStats(emptyStore(), date),
          checkinToday: { evening: { [f.id]: value } },
        });
        expect(raw.checkinToday?.evening).toHaveProperty(f.id);
      }
    expect(fields.has('answeredAtV2')).toBe(true);
  });
  it('compares priority with evening outcome and never turns categories into hours', () => {
    const a = analyzeObservations(
      {
        [date]: {
          morning: { ...morning, confirmed: true },
          afternoon: { questionVersion: 2, confirmed: true, currentActivityV2: 'taxi' },
          evening: { ...evening, priorityOutcomeV2: 'finished', confirmed: true },
        },
      },
      date,
    );
    expect(a.outcomes.finished).toBe(1);
    expect(a.activities.mate).toBe(1);
    expect(a.activities.taxi).toBe(1);
    expect(a.facts.lowerEnergy).toBe(1);
    expect(a.facts.energyPairs).toBe(1);
  });
  it('factor comparison excludes unknown and missing factors; requires 8 in each group', () => {
    const days = Array.from({ length: 16 }, (_, i) =>
      observationDay(date, {
        evening: {
          ...evening,
          confirmed: true,
          helpersV2: i < 8 ? ['rest'] : ['none'],
          satisfactionV2: i < 8 ? 5 : 2,
        },
      }),
    );
    expect(compareObservedFactor(days.slice(1), 'helpersV2', 'rest').eligible).toBe(false);
    const comparison = compareObservedFactor(days, 'helpersV2', 'rest');
    expect(comparison.eligible).toBe(true);
    expect(comparison.difference).toBe(3);
    const unknown = observationDay(date, {
      evening: { ...evening, confirmed: true, helpersV2: ['unknown'] },
    });
    expect(compareObservedFactor([unknown], 'helpersV2', 'rest').withoutFactor.n).toBe(0);
    const missing = observationDay(date, { evening: { ...evening, confirmed: true } });
    expect(compareObservedFactor([missing], 'helpersV2', 'rest').withoutFactor.n).toBe(0);
  });
  it('sleep episodes are not double-counted and circular regularity handles midnight', () => {
    const d = observationDay(date, {
      morning: {
        ...morning,
        confirmed: true,
        sleepAttemptV2: '2026-10-03T23:00',
        sleepWakeV2: '2026-10-04T07:00',
      },
      evening: {
        ...evening,
        confirmed: true,
        extraNapV2: 'yes',
        napStartV2: '2026-10-04T06:00',
        napMinutesV2: 120,
      },
    });
    expect(d.napOverlap).toBe(true);
    expect(d.napMinutes).toBeNull();
    expect(
      clockRegularity(
        [d, { ...d, morning: { ...d.morning, sleepAttemptV2: '2026-10-04T01:00' } }],
        'sleepAttemptV2',
      ).spreadMinutes,
    ).toBeCloseTo(60);
  });
  it('previous period remains separate by slot; assistant can read v2 observations', () => {
    const records = demoObservations(date),
      a = analyzeObservations(records, date, 7);
    expect(a.previous).toHaveLength(7);
    expect(a.previousTo).toBe('2026-09-27');
    const period = buildCheckinPeriod(records, date, 7);
    expect(period.observationsV2.facts.confirmedSlots).toBeGreaterThan(0);
    expect(period.observationsV2.currentMetrics['morning.energy'].n).toBeGreaterThan(0);
    expect(period.observationsV2).not.toHaveProperty('current');
    expect(period.observationsV2).not.toHaveProperty('previous');
  });
});
describe('check-in preferences and configured windows', () => {
  it('archives new scales separately with denominators; old scores are not renamed', () => {
    const store = {
      checkins: {
        [date]: {
          morning: { ...morning, confirmed: true },
          evening: { ...evening, confirmed: true },
        },
      },
    };
    const month = monthlyRollup(store, date)['2026-10'];
    expect(month.dayScoreAvg).toBeNull();
    expect(month.sleepAvg).toBeNull();
    expect(month.observationsV2.metrics.sleepHours).toMatchObject({ n: 1, average: 7.5 });
    expect(month.observationsV2.metrics.satisfaction).toMatchObject({ n: 1, average: 4 });
    expect(Object.values(weeklyRollup(store, date))[0]?.observationsV2.days).toBe(1);
  });
  const prefs = {
    schedule: { morning: '09:30', afternoon: '15:00', evening: '21:00', end: '03:00' },
  };
  it('is available to settings and clock, handles minutes and midnight boundaries', () => {
    const p = normalizeSettings({ checkin: prefs });
    expect(p.checkin?.schedule.morning).toBe('09:30');
    expect(checkinClock(569, p.checkin).slot).toBeNull();
    expect(checkinClock(570, p.checkin).slot).toBe('morning');
    expect(checkinClock(899, p.checkin).endsIn).toBe(1);
    expect(checkinClock(900, p.checkin).slot).toBe('afternoon');
    expect(checkinClock(179, p.checkin)).toMatchObject({
      slot: 'evening',
      previousDay: true,
      endsIn: 1,
    });
    expect(checkinClock(180, p.checkin).slot).toBeNull();
    expect(checkinClock(1200, p.checkin).nextIn).toBe(60);
  });
  it('refuses overlap and invalid values, preserves custom categories and chosen modules', () => {
    expect(
      validSchedule({ morning: '15:00', afternoon: '10:00', evening: '20:00', end: '02:00' }),
    ).toBe(false);
    const p = normalizeCheckinPreferences({
      modules: ['learning', 'bad'],
      habits: [{ id: 'reading', name: ' Читання ', days: [1, 1, 9] }],
      categories: [{ id: 'custom_music', name: 'Музика', group: 'Люди й дозвілля' }],
    });
    expect(p.modules).toEqual(['learning']);
    expect(p.habits[0]?.days).toEqual([1]);
    expect(p.categories[0]?.group).toBe('Люди й дозвілля');
  });
  it('reminds only inside configured active windows', () => {
    expect(checkinReminder(840, prefs)?.slot).toBe('morning');
    expect(checkinReminder(890, prefs)).toBeNull();
    expect(checkinReminder(30, prefs)).toBeNull();
    expect(checkinReminder(1410, prefs)?.slot).toBe('evening');
  });
});
