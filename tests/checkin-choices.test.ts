import { describe, expect, it } from 'vitest';
import {
  applyChoiceCommand,
  normalizeChoiceCatalog,
  publicChoiceCatalog,
  choiceAnswerLabel,
  editableChoiceField,
} from '../web/core/checkin/choices.mjs';
import {
  CHECKIN_CARDS_V4,
  FOLLOWUP_CARDS_V4,
  clearHiddenV4,
  contextualCardV4,
  contextualFieldV4,
  fieldVisibleV4,
  choiceSnapshotV4,
  coreCompleteV4,
  currentPlanV4,
} from '../web/core/checkin/adaptive-v4.mjs';
import { adaptiveModel } from '../web/core/checkin/model.mjs';
import { adaptiveDay, adaptiveMetrics } from '../web/core/checkin/adaptive-observations.mjs';
import { emptyStore, recordEvent } from '../web/stats-core.mjs';
const fields = [...Object.values(CHECKIN_CARDS_V4).flat(), ...FOLLOWUP_CARDS_V4].flatMap(
  (c) => c.fields,
);
const f = (id: string) => fields.find((f) => f.id === id)!;
const command = {
  op: 'create' as const,
  requestId: 'request_12345678',
  expectedRevision: 0,
  field: 'moodFactorsV4',
  optionId: 'user_12345678',
  label: 'Ранкова кава з коханою',
  group: 'Маленькі радощі',
  scope: 'mood:positive',
};
const morning = { questionVersion: 4, sleepModeV4: 'none', energy: 4, mood: 4, priorityV4: 'rest' };

describe('strict contextual choices', () => {
  it.each([1, 2, 3, 4, 5])(
    'filters the complete mood list, including overrides, for %s',
    (mood) => {
      const c = FOLLOWUP_CARDS_V4.find((c) => c.id === 'mood-context')!;
      const choices = applyChoiceCommand(null, command, fields);
      const options = contextualCardV4(c, { mood }, { choices }).fields[0]!.options!.map(
        ([, id]) => id,
      );
      expect(options.includes('conflict')).toBe(mood <= 3);
      expect(options.includes('weather_good')).toBe(mood >= 3);
      expect(options.includes(command.optionId)).toBe(mood >= 3);
      const edited = applyChoiceCommand(
        choices,
        {
          op: 'update',
          requestId: 'edit_12345678',
          expectedRevision: 1,
          field: 'moodFactorsV4',
          optionId: 'conflict',
          label: 'Суперечка',
          group: 'Люди',
        },
        fields,
      );
      expect(
        contextualCardV4(c, { mood: 5 }, { choices: edited }).fields[0]!.options!.map(
          ([, id]) => id,
        ),
      ).not.toContain('conflict');
    },
  );
  it('removes selected opposite causes and their Other text after a controller changes', () => {
    const choices = applyChoiceCommand(null, command, fields);
    const a = clearHiddenV4(
      'morning',
      { ...morning, mood: 1, moodFactorsV4: ['weather_bad', command.optionId, 'conflict'] },
      { choices },
    );
    expect(a.moodFactorsV4).toEqual(['weather_bad', 'conflict']);
    const low = clearHiddenV4('morning', { ...a, mood: 5 }, { choices });
    expect(low.moodFactorsV4).toBeUndefined();
    expect(
      clearHiddenV4('morning', { ...morning, moodFactorsV4Other: 'Без вибору' }).moodFactorsV4Other,
    ).toBeUndefined();
  });
  it.each([
    ['sleepy', 'sleep', 'missed_food'],
    ['physical', 'physical_load', 'unclear'],
    ['mental', 'many_tasks', 'missed_food'],
    ['emotional', 'stress', 'physical_load'],
    ['activation', 'unclear', 'physical_load'],
    ['hunger', 'missed_food', 'sleep'],
    ['discomfort', 'health', 'many_tasks'],
  ])('links %s fatigue to its own causes', (kind, yes, no) => {
    const a = clearHiddenV4('morning', {
      ...morning,
      energy: 1,
      energyKindV4: [kind],
      energyFactorsV4: [yes, no],
    });
    expect(a.energyFactorsV4).toEqual([yes]);
    expect(clearHiddenV4('morning', { ...a, energy: 5 }).energyKindV4).toBeUndefined();
    expect(clearHiddenV4('morning', { ...a, energy: 5 }).energyFactorsV4).toBeUndefined();
  });
  it('waits for the fatigue kind and combines only selected kinds', () => {
    expect(fieldVisibleV4(f('energyFactorsV4'), { energy: 1 })).toBe(false);
    const a = clearHiddenV4('morning', {
      ...morning,
      energy: 1,
      energyKindV4: ['hunger', 'mental'],
      energyFactorsV4: ['missed_food', 'stress', 'physical_load'],
    });
    expect(a.energyFactorsV4).toEqual(['missed_food', 'stress']);
  });
  it.each([1, 2, 3, 4, 5, 'na', 'unknown'])(
    'branches learning details after comprehension %s',
    (score) => {
      for (const direction of ['study', 'course']) {
        const a = clearHiddenV4('evening', {
          questionVersion: 4,
          developmentActualV4: [direction],
          [`${direction}ComprehensionV4`]: score,
          [`${direction}ChallengesV4`]: ['pace'],
          [`${direction}HelpersV4`]: ['examples'],
        });
        expect(!!a[`${direction}ChallengesV4`]).toBe([1, 2, 3].includes(Number(score)));
        expect(!!a[`${direction}HelpersV4`]).toBe([3, 4, 5].includes(Number(score)));
      }
    },
  );
  it('does not claim enough free time when there was none, or no need for breaks after long work', () => {
    const a = clearHiddenV4('evening', {
      questionVersion: 4,
      freeTimeV4: 'zero',
      freeTimeEnoughV4: 4,
      workRangeV4: '8_12h',
      workBreaksV4: 'na',
      workLoadV4: 5,
      workFactorsV4: ['few_orders', 'many_tasks', 'support'],
    });
    expect(a.freeTimeEnoughV4).toBeUndefined();
    expect(a.workBreaksV4).toBeUndefined();
    expect(a.workFactorsV4).toEqual(['many_tasks', 'support']);
  });
  it('does not attribute untried practice, nonexistent sleep or absent breaks against explicit answers', () => {
    const m = clearHiddenV4('morning', {
      ...morning,
      moodFactorsV4: ['slept_well', 'weather_good'],
      energyHelpersV4: ['sleep', 'rest'],
    });
    expect(m.moodFactorsV4).toEqual(['weather_good']);
    expect(m.energyHelpersV4).toEqual(['rest']);
    const e = clearHiddenV4('evening', {
      questionVersion: 4,
      developmentActualV4: ['course'],
      courseComprehensionV4: 5,
      coursePracticeV4: 'not_tried',
      courseHelpersV4: ['practice', 'examples'],
      workLoadV4: 5,
      workBreaksV4: 'enough',
      workFactorsV4: ['no_breaks', 'support'],
    });
    expect(e.courseHelpersV4).toEqual(['examples']);
    expect(e.workFactorsV4).toEqual(['support']);
  });
});

describe('personal choice catalog', () => {
  it('creates, edits, deletes and restores with stable identity, preserving selected snapshots', () => {
    let c = applyChoiceCommand(null, command, fields);
    const a = { ...morning, moodFactorsV4: [command.optionId] };
    const snapshot = choiceSnapshotV4('morning', a, { choices: c });
    expect(choiceAnswerLabel(f('moodFactorsV4'), a.moodFactorsV4, snapshot)).toBe(command.label);
    c = applyChoiceCommand(
      c,
      {
        ...command,
        op: 'update',
        label: 'Приємний ранок',
        group: 'Моє',
        expectedRevision: 1,
        requestId: 'update_12345678',
      },
      fields,
    );
    expect(choiceAnswerLabel(f('moodFactorsV4'), a.moodFactorsV4, snapshot)).toBe(command.label);
    c = applyChoiceCommand(
      c,
      { ...command, op: 'delete', expectedRevision: 2, requestId: 'delete_12345678' },
      fields,
    );
    expect(clearHiddenV4('morning', a, { choices: c }).moodFactorsV4).toBeUndefined();
    c = applyChoiceCommand(
      c,
      { ...command, op: 'restore', expectedRevision: 3, requestId: 'restore_12345678' },
      fields,
    );
    expect(clearHiddenV4('morning', a, { choices: c }).moodFactorsV4).toEqual([command.optionId]);
    expect(
      choiceSnapshotV4('morning', a, { choices: c }).optionLabelsV4.moodFactorsV4?.[
        command.optionId
      ],
    ).toBe('Моє :: Приємний ранок');
  });
  it('is retry safe and rejects stale or conflicting concurrent commands', () => {
    const c = applyChoiceCommand(null, command, fields);
    expect(applyChoiceCommand(c, command, fields)).toEqual(c);
    expect(() => applyChoiceCommand(c, { ...command, label: 'Інший зміст' }, fields)).toThrow(
      'інший зміст',
    );
    expect(() =>
      applyChoiceCommand(
        c,
        { ...command, requestId: 'concurrent_1234', optionId: 'user_87654321' },
        fields,
      ),
    ).toThrow('іншому пристрої');
    expect(publicChoiceCatalog(c)).not.toHaveProperty('receipts');
  });
  it.each([
    'mood',
    'energy',
    'energyKindV4',
    'sleepModeV4',
    'developmentActualV4',
    'developmentPlanV4',
    'courseRangeV4',
    'courseComprehensionV4',
    'recoveryTargetV4',
  ])('protects semantic controls: %s', (id) => {
    expect(editableChoiceField(f(id))).toBe(false);
    expect(() => applyChoiceCommand(null, { ...command, field: id }, fields)).toThrow('шкалу');
  });
  it.each(['none', 'unknown', 'other', 'private', 'alone', 'noplan', 'na'])(
    'protects the escape choice %s',
    (optionId) => {
      expect(() =>
        applyChoiceCommand(null, { ...command, op: 'delete', optionId }, fields),
      ).toThrow('службовий');
    },
  );
  it('supports hiding and renaming built-ins without removing them from old records', () => {
    const c = applyChoiceCommand(
      null,
      {
        ...command,
        op: 'update',
        optionId: 'weather_good',
        label: 'Сонце за вікном',
        group: 'Погода',
      },
      fields,
    );
    expect(
      contextualFieldV4(f('moodFactorsV4'), { mood: 1 }).options!.some(
        ([, id]) => id === 'weather_good',
      ),
    ).toBe(false);
    expect(
      choiceSnapshotV4('morning', { ...morning, moodFactorsV4: ['weather_good'] }, { choices: c })
        .optionLabelsV4.moodFactorsV4?.weather_good,
    ).toContain('Сонце');
    const old = { optionLabelsV4: { moodFactorsV4: { weather_good: 'Гарна погода' } } };
    expect(choiceAnswerLabel(f('moodFactorsV4'), ['weather_good'], old)).toBe('Гарна погода');
  });
  it('validates category, scope, limits and duplicates', () => {
    for (const patch of [
      { label: '' },
      { group: '' },
      { label: 'a'.repeat(101) },
      { scope: 'mood:alien' },
      { label: 'Гарна погода' },
    ])
      expect(() => applyChoiceCommand(null, { ...command, ...patch }, fields)).toThrow();
    expect(
      normalizeChoiceCatalog({
        entries: [{ field: 'moodFactorsV4', id: 'none', label: 'x', group: 'x' }],
      }).entries,
    ).toEqual([]);
  });
  it('accepts custom primary plans on both parser and completeness paths', () => {
    const c = applyChoiceCommand(
      null,
      { ...command, field: 'priorityV4', scope: 'default' },
      fields,
    );
    const a = { ...morning, priorityV4: command.optionId };
    const model = adaptiveModel(a, c),
      cleaned = model.clearHidden('morning', model.clean('morning', a).set);
    expect(model.complete('morning', cleaned)).toBe(true);
    expect(coreCompleteV4('morning', a)).toBe(false);
    const saved = { ...a, ...choiceSnapshotV4('morning', a, { choices: c }) };
    expect(currentPlanV4({ morning: saved }).text).toBe(command.label);
  });
  it('records canonical labels, keeps confirmed history immutable, and labels custom metrics', () => {
    const c = applyChoiceCommand(null, command, fields),
      date = '2026-11-04';
    const event = {
      type: 'checkin',
      slot: 'morning',
      ...morning,
      moodFactorsV4: [command.optionId, 'conflict'],
      checkinChoicesV4: c,
      confirmed: true,
      optionLabelsV4: { moodFactorsV4: { [command.optionId]: 'FORGED' } },
    };
    const s = recordEvent(emptyStore(), event, date, null, '2026-11-04T08:00:00Z');
    const good = recordEvent(
      emptyStore(),
      { ...event, moodFactorsV4: [command.optionId] },
      date,
      null,
      '2026-11-04T08:00:00Z',
    );
    expect(s.checkins[date].morning.moodFactorsV4 ?? []).not.toContain('conflict');
    expect(good.checkins[date].morning.optionLabelsV4.moodFactorsV4[command.optionId]).toContain(
      command.label,
    );
    const again = recordEvent(good, { ...event, mood: 1 }, date, null, '2026-11-04T09:00:00Z');
    expect(again.checkins[date].morning).toEqual(good.checkins[date].morning);
    const metric = adaptiveMetrics([adaptiveDay(date, good.checkins[date])])[
      'morning.moodFactorsV4'
    ];
    expect(metric.labels[command.optionId]).toBe(command.label);
  });
});
