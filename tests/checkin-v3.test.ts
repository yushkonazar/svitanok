import { describe, expect, it } from 'vitest';
import {
  CHECKIN_CARDS_V3,
  FOLLOWUP_CARDS_V3,
  adaptiveContext,
  adaptivePreferences,
  checkinGapV3,
  cleanCheckinV3,
  clearHiddenV3,
  coreCompleteV3,
  followupsV3,
  validValueV3,
} from '../web/core/checkin/adaptive.mjs';
import {
  analyzeAdaptive,
  adaptiveMetrics,
  demoAdaptive,
  frequenciesV3,
} from '../web/core/checkin/adaptive-observations.mjs';
import { recordEvent, emptyStore, aggregateStats } from '../web/stats-core.mjs';
import { checkinClock } from '../web/core/checkin/catalog.mjs';
import { normalizeSettings } from '../web/settings-core.mjs';
import { buildCheckinPeriod } from '../web/core/tools/checkin-period.mjs';
import { monthlyRollup, weeklyRollup } from '../web/stats-archive.mjs';
import { statsSchema } from '../web/app/src/api/schema.ts';
const date = '2026-10-06';
const morning = {
  questionVersion: 3,
  sleepModeV3: 'main',
  sleepMinutesV3: 420,
  sleepQualityV3: 2,
  energy: 3,
  mood: 3,
  activitiesV3: ['personal'],
  companyV3: ['alone'],
  priorityV3: 'work',
  developmentPlanV3: 'learn',
};
const evening = {
  questionVersion: 3,
  energy: 2,
  mood: 4,
  satisfactionV3: 4,
  activitiesV3: ['rest'],
  companyV3: ['partner'],
  priorityOutcomeV3: 'finished',
  developmentActualV3: 'none',
  freeTimeV3: 'lt30',
  bedtimePlanV3: '00:00',
  napV3: 'no',
};
const context = {
  morning,
  previous: { mood: 2 },
  previousEvening: { bedtimePlanV3: '23:30' },
  activities: [],
};
const write = (
  s: ReturnType<typeof emptyStore>,
  slot: string,
  answers: ReturnType<typeof emptyStore>,
  iso = '2026-10-06T09:00:00Z',
  day = date,
) => recordEvent(s, { type: 'checkin', slot, ...answers }, day, null, iso);
describe('adaptive check-in v3', () => {
  it('has universal core answers and independent state choices', () => {
    const catalog = JSON.stringify([CHECKIN_CARDS_V3, FOLLOWUP_CARDS_V3]);
    expect(catalog).not.toMatch(/таксі|Mate|мейте|academy/i);
    expect(coreCompleteV3('morning', morning)).toBe(true);
    expect(coreCompleteV3('morning', { ...morning, mood: undefined })).toBe(false);
    expect(Object.values(CHECKIN_CARDS_V3).map((a) => a.length)).toEqual([4, 3, 5]);
  });
  it('does not require inventing a sleep duration', () => {
    expect(coreCompleteV3('morning', { ...morning, sleepMinutesV3: undefined })).toBe(true);
    const r = clearHiddenV3(
      'morning',
      { ...morning, sleepModeV3: 'none', sleepBlockersV3: ['time'] },
      context,
    );
    expect(r.sleepQualityV3).toBeUndefined();
    expect(r.sleepMinutesV3).toBeUndefined();
    expect(r.sleepBlockersV3).toBeUndefined();
    expect(coreCompleteV3('morning', r)).toBe(true);
  });
  it('branches on bad and good sleep and never keeps the opposite explanation', () => {
    expect(followupsV3('morning', morning, context).map((c) => c.id)).toEqual([
      'bedtime',
      'sleep-poor',
    ]);
    const good = clearHiddenV3(
      'morning',
      { ...morning, sleepQualityV3: 5, sleepBlockersV3: ['time'], sleepHelpersV3: ['calm'] },
      context,
    );
    expect(good.sleepBlockersV3).toBeUndefined();
    expect(good.sleepHelpersV3).toEqual(['calm']);
  });
  it('does not show a bedtime comparison without an actual previous evening plan', () => {
    expect(followupsV3('morning', morning).some((c) => c.id === 'bedtime')).toBe(false);
    expect(
      adaptiveContext({ [date]: { morning: { ...morning, confirmed: false } } }, date, 'afternoon')
        .morning,
    ).toEqual({});
  });
  it('clears reasons after changing a delayed bedtime to on-time', () => {
    expect(
      clearHiddenV3(
        'morning',
        { ...morning, bedtimeOutcomeV3: 'ontime', bedtimeReasonsV3: ['phone'] },
        context,
      ).bedtimeReasonsV3,
    ).toBeUndefined();
  });
  it('keeps the short detail budget and already answered relevant branches', () => {
    const a = { ...evening, developmentBlockersV3: ['late_work'] };
    const branches = followupsV3('evening', a, context);
    expect(branches).toHaveLength(2);
    expect(branches[0]!.id).toBe('development-blocked');
    expect(
      followupsV3('evening', { ...a, developmentActualV3: 'learn' }, context).some(
        (c) => c.id === 'development-blocked',
      ),
    ).toBe(false);
  });
  it('uses one learning/reading branch and clears inapplicable comprehension', () => {
    const a = {
      ...evening,
      developmentActualV3: 'read',
      readingRangeV3: '30_60',
      comprehensionV3: 5,
      learningRangeV3: '1_2h',
    };
    const clean = clearHiddenV3('evening', a, {
      ...context,
      morning: { developmentPlanV3: 'read' },
    });
    expect(clean.readingRangeV3).toBe('30_60');
    expect(clean.comprehensionV3).toBeUndefined();
    expect(clean.learningRangeV3).toBeUndefined();
  });
  it('rejects incompatible company selections and unknown-answer mixtures', () => {
    const company = CHECKIN_CARDS_V3.afternoon![1]!.fields[1]!;
    expect(validValueV3(company, ['partner', 'friends'])).toBe(true);
    expect(validValueV3(company, ['alone', 'partner'])).toBe(false);
    expect(validValueV3(company, ['private', 'family'])).toBe(false);
    const reasons = FOLLOWUP_CARDS_V3.find((c) => c.id === 'sleep-poor')!.fields[0]!;
    expect(validValueV3(reasons, ['time', 'unknown'])).toBe(false);
  });
  it('does not accept undeclared fields, forged metadata or exact zero sleep when asleep', () => {
    const clean = cleanCheckinV3('morning', {
      ...morning,
      admin: true,
      shownBranchesV3: ['work'],
      sleepMinutesV3: 0,
    });
    expect(clean.set.admin).toBeUndefined();
    expect(clean.set.shownBranchesV3).toBeUndefined();
    expect(clean.set.sleepMinutesV3).toBeUndefined();
  });
  it('keeps explicit drafts separate from completion and validates confirmation server-side', () => {
    let s = write(emptyStore(), 'morning', { questionVersion: 3, energy: 4, confirmed: true });
    expect(s.checkins[date]).toBeUndefined();
    s = write(s, 'morning', morning);
    expect(s.checkins[date].morning.confirmed).toBeUndefined();
    s = write(s, 'morning', { questionVersion: 3, confirmed: true });
    expect(s.checkins[date].morning.confirmed).toBe(true);
    expect(s.checkins[date].morning.confirmedAtV3).toBe('2026-10-06T09:00:00Z');
    const locked = write(s, 'morning', { questionVersion: 3, energy: 1 });
    expect(locked.checkins[date].morning.energy).toBe(3);
  });
  it('clears incompatible branch data across partial API merges', () => {
    let s = write(emptyStore(), 'morning', { ...morning, sleepBlockersV3: ['time'] });
    s = write(s, 'morning', { questionVersion: 3, sleepQualityV3: 5 });
    expect(s.checkins[date].morning.sleepBlockersV3).toBeUndefined();
    expect(s.checkins[date].morning.answerTimesV3.sleepBlockersV3).toBeUndefined();
  });
  it('upgrades an unfinished draft without changing confirmed history', () => {
    let s = emptyStore();
    s.checkins[date] = { morning: { questionVersion: 2, priorityV2: 'taxi', energy: 5 } };
    s = write(s, 'morning', morning);
    expect(s.checkins[date].morning.priorityV2).toBeUndefined();
    s.checkins['2026-10-05'] = {
      morning: { questionVersion: 2, confirmed: true, priorityV2: 'taxi' },
    };
    s = write(s, 'morning', morning);
    expect(s.checkins['2026-10-05'].morning.priorityV2).toBe('taxi');
  });
  it('preserves custom schedules but migrates old defaults and retains the version', () => {
    const p = adaptivePreferences(null);
    expect(p.schedule.afternoon).toBe('18:00');
    expect(checkinClock(779, p).slot).toBe('morning');
    expect(checkinClock(780, p)).toMatchObject({ slot: null, nextIn: 300 });
    expect(checkinClock(1079, p).slot).toBeNull();
    expect(checkinClock(1080, p).slot).toBe('afternoon');
    expect(checkinClock(30, p).previousDay).toBe(true);
    expect(checkinClock(239, p).slot).toBe('evening');
    expect(checkinClock(240, p).slot).toBeNull();
    const custom = adaptivePreferences({
      schedule: { morning: '06:00', afternoon: '17:00', evening: '21:00', end: '03:00' },
    });
    expect(custom.schedule.afternoon).toBe('17:00');
    expect(
      adaptivePreferences({
        version: 3,
        schedule: { morning: '08:00', afternoon: '14:00', evening: '20:00', end: '02:00' },
      }).schedule.afternoon,
    ).toBe('14:00');
    expect(normalizeSettings({ checkin: { ...p, version: 3 } }).checkin!.version).toBe(3);
  });
  it('spaces observations using the real confirmation timestamp', () => {
    const day = { morning: { confirmed: true, confirmedAtV3: '2026-10-06T12:00:00Z' } };
    expect(checkinGapV3(day, 'afternoon', Date.parse('2026-10-06T13:00:00Z'))).toBe(120);
    expect(checkinGapV3(day, 'afternoon', Date.parse('2026-10-06T15:00:00Z'))).toBe(0);
    expect(
      checkinGapV3(
        { morning: { ...day.morning, confirmed: false } },
        'afternoon',
        Date.parse('2026-10-06T13:00:00Z'),
      ),
    ).toBe(0);
  });
});
describe('adaptive statistics: observations and denominators', () => {
  const records = {
    '2026-10-05': {
      morning: {
        ...morning,
        confirmed: true,
        sleepMinutesV3: undefined,
        sleepBlockersV3: undefined,
      },
      evening: { ...evening, confirmed: true },
    },
    [date]: {
      morning: { ...morning, confirmed: true, sleepBlockersV3: ['time', 'awakenings'] },
      evening: { ...evening, confirmed: false },
    },
  };
  it('excludes drafts, missing durations and earlier versions', () => {
    const a = analyzeAdaptive(
      { ...records, '2026-10-04': { morning: { questionVersion: 2, confirmed: true, energy: 5 } } },
      date,
      3,
    );
    expect(a.recordedDays).toBe(2);
    expect(a.sleep).toEqual({ n: 1, value: 7 });
    expect(a.satisfaction).toEqual({ n: 1, value: 4 });
    expect(a.state.evening!.energy.n).toBe(1);
  });
  it('uses explicit reason responses as the denominator, not all poor nights', () => {
    const a = analyzeAdaptive(records, date, 7),
      f = frequenciesV3(a.current, 'morning', 'sleepBlockersV3');
    expect(a.poorSleep).toBe(2);
    expect(f).toEqual({ n: 1, counts: { time: 1, awakenings: 1 } });
  });
  it('keeps zero sleep distinct from missing quality', () => {
    const a = analyzeAdaptive(
      {
        [date]: {
          morning: {
            ...morning,
            confirmed: true,
            sleepModeV3: 'none',
            sleepMinutesV3: undefined,
            sleepQualityV3: undefined,
          },
        },
      },
      date,
      1,
    );
    expect(a.sleep).toEqual({ n: 1, value: 0 });
    expect(a.sleepQuality.n).toBe(0);
  });
  it('does not transform range selections into exact learning minutes', () => {
    const a = analyzeAdaptive(
      {
        [date]: {
          evening: {
            ...evening,
            confirmed: true,
            developmentActualV3: 'learn',
            learningRangeV3: '1_2h',
          },
        },
      },
      date,
      1,
    );
    const metrics = adaptiveMetrics(a.current);
    expect(metrics['evening.learningRangeV3'].counts).toEqual({ '1_2h': 1 });
    expect(metrics['evening.learningRangeV3'].average).toBeUndefined();
    expect(a.learning).toBe(1);
  });
  it('preserves v3 fields through the frontend schema and sends bounded assistant metrics', () => {
    const s = write(emptyStore(), 'morning', { ...morning, confirmed: true });
    const parsed = statsSchema.parse(aggregateStats(s, date));
    expect(parsed.checkinRaw.records[date]!.morning?.priorityV3).toBe('work');
    const report = buildCheckinPeriod(s.checkins, date, 7);
    expect(report.observationsV3.recordedDays).toBe(1);
    expect(report.observationsV2.recordedDays).toBe(0);
    expect(report.current.recordedDays).toBe(0);
  });
  it('archives new counts and numeric denominators without overwriting v2', () => {
    const s = write(emptyStore(), 'morning', { ...morning, confirmed: true });
    const month = monthlyRollup(s, date)['2026-10'];
    expect(month.observationsV3.metrics['morning.sleepMinutesV3']).toMatchObject({
      numericN: 1,
      sum: 420,
      average: 420,
    });
    expect(
      weeklyRollup(s, date)['2026-10-05'].observationsV3.metrics['morning.companyV3'].counts,
    ).toEqual({ alone: 1 });
  });
  it('has deterministic demo examples with positive and negative contexts', () => {
    expect(demoAdaptive(date)).toEqual(demoAdaptive(date));
    expect(analyzeAdaptive(demoAdaptive(date), date, 30).recordedDays).toBe(30);
  });
});
