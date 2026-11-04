import { describe, expect, it } from 'vitest';
import {
  CHECKIN_CARDS_V4,
  FOLLOWUP_CARDS_V4,
  adaptiveContextV4,
  clearHiddenV4,
  cleanCheckinV4,
  contextualCardV4,
  currentPlanV4,
  eligibleFollowupsV4,
  followupsV4,
  plannedDirectionsV4,
  coreCompleteV4,
  nextSleepDateV4,
} from '../web/core/checkin/adaptive-v4.mjs';
import { adaptiveModel } from '../web/core/checkin/model.mjs';
import { recordEvent, emptyStore } from '../web/stats-core.mjs';
import {
  analyzeAdaptive,
  adaptiveMetrics,
  adaptiveDay,
} from '../web/core/checkin/adaptive-observations.mjs';
import { checkinMorningSchema, checkinEveningSchema } from '../web/app/src/api/schema.ts';

const date = '2026-11-04';
const morning = {
  questionVersion: 4,
  sleepModeV4: 'main',
  sleepQualityV4: 4,
  energy: 1,
  mood: 4,
  priorityV4: 'course',
  developmentPlanV4: ['read'],
  priorityStepV4: 'Пройти другий урок',
};
const evening = {
  questionVersion: 4,
  energy: 2,
  mood: 3,
  priorityOutcomeV4: 'progress',
  developmentActualV4: ['course'],
  freeTimeV4: '60_119',
  satisfactionV4: 4,
  napV4: 'unknown',
};
const context = {
  morning: { ...morning, confirmed: true },
  previous: {},
  previousEvening: { bedtimePlanV3: '23:30' },
  activities: [],
};
const field = (id: string) =>
  [...Object.values(CHECKIN_CARDS_V4).flat(), ...FOLLOWUP_CARDS_V4]
    .flatMap((c) => c.fields)
    .find((f) => f.id === id)!;
const write = (
  s: ReturnType<typeof emptyStore>,
  slot: string,
  answers: Record<string, unknown>,
  at = '2026-11-04T08:00:00Z',
) => recordEvent(s, { type: 'checkin', slot, ...answers }, date, null, at);

describe('explicit v4 observations', () => {
  it('has three morning/day and five evening steps without moving satisfaction into current mood', () => {
    expect(Object.values(CHECKIN_CARDS_V4).map((c) => c.length)).toEqual([3, 3, 5]);
    expect(CHECKIN_CARDS_V4.evening[0]!.fields.map((f) => f.id)).toEqual(['energy', 'mood']);
    expect(coreCompleteV4('morning', morning)).toBe(true);
    expect(coreCompleteV4('evening', evening)).toBe(true);
  });
  it('suggests at most two topics but retains every manually added relevant answer', () => {
    const initial = followupsV4('morning', morning, context);
    expect(initial).toHaveLength(2);
    expect(eligibleFollowupsV4('morning', morning, context).map((c) => c.id)).toContain(
      'energy-context',
    );
    const a = clearHiddenV4(
      'morning',
      {
        ...morning,
        detailTopicsV4: ['mood-context', 'energy-context'],
        moodFactorsV4: ['weather_good', 'partner_good', 'poor_sleep'],
        energyKindV4: ['mental', 'physical'],
        energyFactorsV4: ['stress', 'physical_load', 'sleep'],
      },
      context,
    );
    expect(a.moodFactorsV4).toHaveLength(3);
    expect(a.energyFactorsV4).toHaveLength(3);
    expect(followupsV4('morning', a, context).length).toBeGreaterThan(2);
    expect(clearHiddenV4('morning', { ...a, sleepQualityV4: 1 }, context).moodFactorsV4).toEqual(
      a.moodFactorsV4,
    );
  });
  it.each([1, 2, 3, 4, 5])('allows mixed mood reasons for rating %s', (mood) => {
    const a = clearHiddenV4('afternoon', {
      questionVersion: 4,
      mood,
      energy: 3,
      priorityPaceV4: 'later',
      moodFactorsV4: ['weather_good', 'partner_hard'],
    });
    expect(a.moodFactorsV4).toEqual(['weather_good', 'partner_hard']);
    expect(eligibleFollowupsV4('afternoon', a).map((c) => c.id)).toContain('mood-context');
  });
  it('clears Other text when its controlling choice is removed, on client and server', () => {
    const a = { ...morning, sleepHelpersV4: ['other'], sleepHelpersV4Other: 'Мені допомогла тиша' };
    expect(cleanCheckinV4('morning', a).set.sleepHelpersV4Other).toContain('тиша');
    expect(clearHiddenV4('morning', a).sleepHelpersV4Other).toContain('тиша');
    expect(
      clearHiddenV4('morning', { ...a, sleepHelpersV4: ['calm'] }).sleepHelpersV4Other,
    ).toBeUndefined();
  });
  it('keeps exclusive choices and the three-cause limit server enforced', () => {
    expect(
      cleanCheckinV4('morning', { moodFactorsV4: ['none', 'weather_good'] }).set.moodFactorsV4,
    ).toBeUndefined();
    expect(
      cleanCheckinV4('morning', { moodFactorsV4: ['rest', 'success', 'family', 'friends'] }).set
        .moodFactorsV4,
    ).toBeUndefined();
    expect(
      cleanCheckinV4('morning', { companyV4: ['alone', 'partner'] }).set.companyV4,
    ).toBeUndefined();
  });
  it('uses an already selected priority as intention, without asking it twice', () => {
    expect(plannedDirectionsV4(morning)).toEqual(['course', 'read']);
    const c = contextualCardV4(
      CHECKIN_CARDS_V4.morning.find((c) => c.id === 'priority')!,
      morning,
    );
    const plan = c.fields.find((f) => f.id === 'developmentPlanV4')!;
    expect(plan.label).toContain('Курс вже в плані');
    expect(plan.options?.some(([, v]) => v === 'course')).toBe(false);
    expect(plan.options?.find(([, v]) => v === 'none')?.[0]).toBe('Більше нічого не додаю');
    expect(
      clearHiddenV4('morning', { ...morning, developmentPlanV4: ['course', 'read'] })
        .developmentPlanV4,
    ).toEqual(['read']);
  });
  it.each([
    ['study'],
    ['course'],
    ['read'],
    ['study', 'course'],
    ['study', 'read'],
    ['course', 'read'],
    ['study', 'course', 'read'],
  ])('keeps independent actual directions %j without inventing others', (...actual) => {
    const a = clearHiddenV4('evening', { ...evening, developmentActualV4: actual }, context);
    expect(a.developmentActualV4).toEqual(actual);
    const topics = eligibleFollowupsV4('evening', a, context).map((c) => c.id);
    for (const id of ['study', 'course', 'read'])
      expect(topics.includes(`development-${id}`)).toBe(actual.includes(id));
  });
  it('asks missing direction independently and does not treat unknown as absence', () => {
    const topics = eligibleFollowupsV4('evening', evening, context).map((c) => c.id);
    expect(topics).toContain('missing-read');
    expect(topics).not.toContain('missing-course');
    expect(
      eligibleFollowupsV4(
        'evening',
        { ...evening, developmentActualV4: ['unknown'] },
        context,
      ).some((c) => c.id.startsWith('missing-')),
    ).toBe(false);
    expect(
      clearHiddenV4('evening', { ...evening, studyRangeV4: '30_59' }, context).studyRangeV4,
    ).toBeUndefined();
    expect(followupsV4('evening', evening, context).map((c) => c.id)).toEqual([
      'development-course',
      'missing-read',
    ]);
  });
  it('preserves support AND obstacles for partial results, without forcing obstacles for later', () => {
    const a = { ...evening, priorityReasonsV4: ['fatigue'], priorityHelpersV4: ['support'] };
    expect(clearHiddenV4('evening', a).priorityReasonsV4).toEqual(['fatigue']);
    expect(clearHiddenV4('evening', a).priorityHelpersV4).toEqual(['support']);
    expect(
      eligibleFollowupsV4('afternoon', { priorityPaceV4: 'later' }).some(
        (c) => c.id === 'plan-blocked',
      ),
    ).toBe(false);
  });
  it('carries a confirmed afternoon change forward with provenance; never silently falls back to the old plan', () => {
    const records = {
      [date]: {
        morning: { ...morning, confirmed: true },
        afternoon: {
          questionVersion: 4,
          confirmed: true,
          priorityPaceV4: 'changed',
          newPriorityV4: 'Відпочити після роботи',
          confirmedAtV3: '2026-11-04T15:00:00Z',
        },
      },
    };
    const c = adaptiveContextV4(records, date, 'evening');
    expect(currentPlanV4(c)).toEqual({
      text: 'Відпочити після роботи',
      source: 'Денна зміна плану',
      at: '2026-11-04T15:00:00Z',
    });
    delete (records[date].afternoon as Record<string, unknown>).newPriorityV4;
    expect(currentPlanV4(adaptiveContextV4(records, date, 'evening')).text).toContain(
      'нова справа не записана',
    );
    expect(records[date].morning.priorityStepV4).toBe(morning.priorityStepV4);
  });
  it('anchors activities to a confirmed timestamp, with a precise fallback if absent', () => {
    const c = CHECKIN_CARDS_V4.afternoon.find((c) => c.id === 'context')!;
    expect(
      contextualCardV4(c, {}, { previous: { confirmedAtV3: '2026-11-04T08:14:00Z' } }).fields[0]!
        .label,
    ).toContain('10:14');
    expect(contextualCardV4(c, {}).fields[0]!.label).toContain('сьогодні до цього моменту');
  });
  it('does not restrict work experiences by perceived load, and allows explicit manual work details', () => {
    const a = clearHiddenV4('evening', {
      ...evening,
      detailTopicsV4: ['work'],
      workLoadV4: 1,
      workFactorsV4: ['few_orders', 'income', 'no_breaks'],
    });
    expect(a.workFactorsV4).toHaveLength(3);
    expect(followupsV4('evening', a).some((c) => c.id === 'work')).toBe(true);
  });
  it('names recovery activity, and clears its effect when no comparison target remains', () => {
    const c = FOLLOWUP_CARDS_V4.find((c) => c.id === 'recovery')!;
    expect(
      contextualCardV4(c, { recoveryTargetV4: 'walk' }).fields.find(
        (f) => f.id === 'recoveryEffectV4',
      )?.label,
    ).toContain('після прогулянки');
    expect(
      clearHiddenV4('evening', { ...evening, recoveryEffectV4: 4 }).recoveryEffectV4,
    ).toBeUndefined();
  });
  it('retains confirmed old records unchanged and selects their original catalog', () => {
    const old = {
      questionVersion: 3,
      confirmed: true,
      developmentActualV3: 'learn',
      learningRangeV3: '30_60',
    };
    const s = emptyStore();
    s.checkins[date] = { evening: old };
    expect(write(s, 'evening', { ...evening, confirmed: true }).checkins[date].evening).toEqual(
      old,
    );
    expect(adaptiveModel(old).details.find((c) => c.id === 'learning')?.title).toContain(
      'Навчання',
    );
    expect(
      plannedDirectionsV4({ questionVersion: 3, priorityV3: 'learn', developmentPlanV3: 'learn' }),
    ).toEqual([]);
  });
  it('saves new manual details and independent answers through storage, schema, metrics and analysis', () => {
    let s = write(emptyStore(), 'morning', { ...morning, confirmed: true });
    const answers = {
      ...evening,
      detailTopicsV4: ['work', 'mood-context', 'development-course'],
      moodFactorsV4: ['weather_good', 'partner_good'],
      courseRangeV4: '30_59',
      courseComprehensionV4: 5,
      coursePracticeV4: 'not_tried',
      workFactorsV4: ['few_orders'],
      confirmed: true,
    };
    s = write(s, 'evening', answers, '2026-11-04T21:00:00Z');
    const saved = s.checkins[date].evening;
    expect(saved.confirmed).toBe(true);
    expect(saved.planSourceV4).toBe('Ранковий план');
    expect(checkinEveningSchema.parse(saved).courseRangeV4).toBe('30_59');
    expect(checkinMorningSchema.parse(s.checkins[date].morning).priorityV4).toBe('course');
    const a = analyzeAdaptive(s.checkins, date, 7);
    expect(a.learning).toBe(0);
    expect(a.course).toBe(1);
    expect(a.reading).toBe(0);
    expect(a.directionOutcomes.course).toEqual({ planned: 1, observed: 1, met: 1 });
    expect(a.directionOutcomes.read).toEqual({ planned: 1, observed: 1, met: 0 });
    expect(adaptiveMetrics(a.current)['evening.courseRangeV4'].numericN).toBeUndefined();
    expect(adaptiveMetrics(a.current)['evening.moodFactorsV4'].counts.weather_good).toBe(1);
    expect(saved.napMinutesV4).toBeUndefined();
  });
  it('distinguishes unknown sleep duration and dates the next sleep across midnight', () => {
    expect(
      clearHiddenV4('morning', {
        ...morning,
        sleepDurationStatusV4: 'unknown',
        sleepMinutesV4: 480,
      }).sleepMinutesV4,
    ).toBeUndefined();
    expect(nextSleepDateV4(Date.parse('2026-11-04T21:40:00Z'), '00:30')).toBe('2026-11-05');
    expect(nextSleepDateV4(Date.parse('2026-11-04T22:40:00Z'), '01:30')).toBe('2026-11-05');
    expect(nextSleepDateV4(Date.parse('2026-11-04T22:40:00Z'), null)).toBeNull();
  });
  it('does not invent sleep minutes or development facts for missing and unknown answers', () => {
    expect(adaptiveDay(date, { morning: { ...morning, confirmed: true } }).sleepHours).toBeNull();
    expect(
      adaptiveDay(date, { morning: { ...morning, sleepModeV4: 'none', confirmed: true } })
        .sleepHours,
    ).toBe(0);
    expect(cleanCheckinV4('evening', evening).set.napMinutesV4).toBeUndefined();
    expect(field('freeTimeV4').options?.map(([, v]) => v)).toEqual([
      'zero',
      '1_29',
      '30_59',
      '60_119',
      '120_239',
      '240_plus',
      'unknown',
    ]);
  });
});
