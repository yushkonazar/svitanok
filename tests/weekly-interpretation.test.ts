import { expect, it } from 'vitest';
import { weeklyPersonalPatterns } from '../web/core/brain/weekly-patterns.mjs';
import { weeklyPersonalPeriods } from '../web/core/brain/weekly-personal.mjs';
import { weeklySummary } from '../web/core/tools/weekly-summary.mjs';
import { interpretWeeklyReport } from '../web/core/brain/weekly-interpretation.mjs';
import {
  parseWeeklyDecision,
  renderWeeklyOverview,
} from '../web/core/brain/weekly-report-format.mjs';
import { conciseFixture } from './helpers/weekly-fixture.ts';
import { financeDisplay, DEFAULT_THRESHOLDS } from '../web/core/finance/display.mjs';
import { precipitationFields } from '../web/precipitation.mjs';

const answer = (energy: number, extra: Record<string, unknown> = {}) => ({
  confirmed: true,
  questionVersion: 3,
  energy,
  ...extra,
});
it('pairs the same confirmed days and counts only explicit low-energy explanations', () => {
  const patterns = weeklyPersonalPatterns({
    '2026-10-19': {
      morning: answer(4, { energyFactorsV3: ['stress'] }),
      evening: answer(2, { energyFactorsV3: ['no_breaks', 'no_breaks'] }),
    },
    '2026-10-20': { morning: answer(5), evening: answer(2, { energyFactorsV3: ['no_breaks'] }) },
    '2026-10-21': { morning: answer(3), evening: { ...answer(1), confirmed: false } },
    '2026-10-22': { morning: { ...answer(3), questionVersion: 2 }, evening: answer(1) },
  });
  expect(patterns.energy.pairs).toBe(2);
  expect(patterns.energy.lowerDays).toBe(2);
  expect(patterns.energy.factors).toEqual({ answeredDays: 2, counts: { no_breaks: 2 } });
  expect(patterns.energy.lowDays).toBe(3);
});
it('excludes answers after the frozen cutoff and preserves patterns through repeated compaction', () => {
  const fixture = conciseFixture();
  const periods = weeklyPersonalPeriods(
    {
      '2026-10-19': { morning: answer(4), evening: answer(2, { energyFactorsV3: ['no_breaks'] }) },
      '2026-10-25': {
        morning: answer(4),
        evening: answer(1, { confirmedAtV3: '2026-10-26T12:00:00Z', energyFactorsV3: ['stress'] }),
      },
    },
    Date.parse('2026-10-26T06:00:00Z'),
    fixture.period,
  );
  expect(periods.current.patterns.energy.pairs).toBe(1);
  const summary = weeklySummary({ ...fixture, personalPeriods: periods });
  expect(weeklySummary(summary).personalPeriods?.current?.patterns).toEqual(
    periods.current.patterns,
  );
  expect(JSON.stringify(summary)).not.toContain('energyFactorsV3');
});
it('explains a repeated energy drop with the owner’s reasons and keeps evidence secondary', () => {
  const fixture = conciseFixture();
  const patterns = weeklyPersonalPatterns(
    Object.fromEntries(
      [19, 20, 21, 22, 23].map((day) => [
        `2026-10-${day}`,
        { morning: answer(4), evening: answer(2, { energyFactorsV3: ['no_breaks'] }) },
      ]),
    ),
  );
  const details = weeklySummary({
    ...fixture,
    personalPeriods: {
      ...fixture.personalPeriods,
      current: { ...fixture.personalPeriods.current, patterns },
    },
  });
  const report = interpretWeeklyReport(details);
  const personal = report.sections.find((s) => s.kind === 'personal')!;
  expect(personal.title).toContain('До вечора');
  expect(personal.paragraphs.join(' ')).toContain('довгу роботу без перерв');
  expect(personal.paragraphs.join(' ')).toContain('ти пов’язував');
  expect(report.actions[0]).toContain('перерву');
  expect(personal.evidence).toContainEqual({ label: 'Зіставлено', value: '5 днів' });
});
it('does not invent a cause or treat unpaired averages as a within-day trend', () => {
  const fixture = conciseFixture();
  const report = interpretWeeklyReport(weeklySummary(fixture));
  const text = report.sections.find((s) => s.kind === 'personal')!.paragraphs.join(' ');
  expect(text).toContain('недостатньо');
  expect(text).not.toMatch(/перевтом|через роботу|до вечора спадала/);
  const details = {
    ...weeklySummary(fixture),
    finance: { ...fixture.finance, comparison: { ...fixture.finance.comparison, complete: false } },
  };
  const finance = interpretWeeklyReport(details).sections.find((s) => s.kind === 'finance')!;
  expect(finance.title).toContain('бракує бази');
});
it('retains rich model sections without making the Telegram message longer', () => {
  const fixture = conciseFixture(),
    details = weeklySummary(fixture);
  const decision = {
    highlights: [{ kind: 'finance', text: 'Витрати стали нижчими за перевірену базу.' }],
    actions: [],
    sections: [
      {
        kind: 'finance',
        title: 'Змінився характер витрат',
        paragraphs: [
          'Змістовне пояснення. '.repeat(20),
          'Додаткові перевірені обставини. '.repeat(12),
        ],
      },
    ],
  };
  const result = renderWeeklyOverview(JSON.stringify(decision), {
    period: fixture.period,
    details,
    missing: [],
  });
  expect(result.valid).toBe(true);
  expect(result.text.length).toBeLessThan(2200);
  expect(result.text).not.toContain('Додаткові перевірені');
  expect(result.decision).toHaveProperty('sections');
  const analysis = interpretWeeklyReport(details, result.decision);
  expect(analysis.sections.find((s) => s.kind === 'finance')!.title).toBe(
    decision.sections[0]!.title,
  );
  expect(
    parseWeeklyDecision(
      JSON.stringify({
        ...decision,
        sections: [{ ...decision.sections[0], paragraphs: ['x'.repeat(701)] }],
      }),
    ),
  ).not.toHaveProperty('sections');
});
it('expands the old default expense palette while preserving custom and empty ranges', () => {
  expect(financeDisplay({ expenseThresholds: [20000, 100000, 300000] }).expenseThresholds).toEqual(
    DEFAULT_THRESHOLDS,
  );
  expect(DEFAULT_THRESHOLDS).toHaveLength(10);
  expect(financeDisplay({ expenseThresholds: [3000, 12000, 90000] }).expenseThresholds).toEqual([
    3000, 12000, 90000,
  ]);
  expect(financeDisplay({ expenseThresholds: [] }).expenseThresholds).toEqual([]);
  expect(
    financeDisplay({ paletteVersion: 2, expenseThresholds: [20000, 100000, 300000] })
      .expenseThresholds,
  ).toEqual([20000, 100000, 300000]);
});
it('preserves actual rain/snow amounts and never guesses precipitation from temperature', () => {
  expect(precipitationFields({ rain: { '1h': 1.2 }, snow: { '1h': 0.4 } })).toEqual({
    rainMm: 1.2,
    snowMm: 0.4,
    precipMm: 1.6,
    precipType: 'mixed',
  });
  expect(precipitationFields({ weather: [{ id: 601 }] })).toEqual({ precipType: 'snow' });
  expect(precipitationFields({ weather: [{ id: 800 }] })).toEqual({});
  expect(precipitationFields({ rain: { '1h': NaN }, snow: { '1h': -1 } })).toEqual({});
});
