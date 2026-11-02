import { expect, it, vi } from 'vitest';
import { readWeeklyReports } from '../web/api-weekly-reports.mjs';
import { weeklyPersonalPeriods } from '../web/core/brain/weekly-personal.mjs';
import { weeklySummary } from '../web/core/tools/weekly-summary.mjs';
import { weeklyReportsSchema } from '../web/app/src/api/weekly-report-schema.ts';
import { workerEnv } from './helpers/env.ts';
import { conciseFixture } from './helpers/weekly-fixture.ts';

function setup(withPatterns = false) {
  const fixture = conciseFixture();
  const checkins: Record<string, Record<string, unknown>> = Object.fromEntries(
    [19, 20, 21, 22].map((day) => [
      `2026-10-${day}`,
      {
        morning: { confirmed: true, questionVersion: 3, energy: 4 },
        evening: { confirmed: true, questionVersion: 3, energy: 2, energyFactorsV3: ['no_breaks'] },
      },
    ]),
  );
  const details = weeklySummary({
    ...fixture,
    personalPeriods: weeklyPersonalPeriods(
      checkins,
      Date.parse(fixture.period.asOf),
      fixture.period,
    ),
  });
  if (!withPatterns) details.personalPeriods!.current!.patterns = null;
  const row = {
    id: 'saved',
    period_from: fixture.period.dateFrom,
    period_to: fixture.period.dateTo,
    status: 'ready',
    as_of: fixture.period.asOf,
    created_at: fixture.period.asOf,
    text_md: 'Збережений короткий огляд',
    quality_json: JSON.stringify({ details, missing: [] }),
  };
  // Only SELECT exists; any accidental write/seed fails the test.
  const db = {
    prepare: (sql: string) => {
      expect(sql.trim().startsWith('SELECT')).toBe(true);
      return { bind: () => ({ all: async () => ({ results: [row] }) }) };
    },
  };
  const peek = vi.fn(async () => ({ value: { checkins } }));
  const legacyRead = vi.fn(() => {
    throw new Error('must not seed/read a mutable store');
  });
  const env = workerEnv({ DB: db, STATE_STORE: { getByName: () => ({ peek, read: legacyRead }) } });
  return { env, row, checkins, peek, legacyRead };
}

it('restores historical reasons only from matching frozen answers without changing the saved report', async () => {
  const s = setup(),
    original = s.row.quality_json;
  s.checkins['2026-10-25'] = {
    morning: {
      confirmed: true,
      questionVersion: 3,
      energy: 1,
      confirmedAtV3: '2026-10-26T12:00:00Z',
      energyFactorsV3: ['stress'],
    },
  };
  const data = await readWeeklyReports(s.env);
  expect(weeklyReportsSchema.safeParse(data).success).toBe(true);
  expect(
    data.report?.analysis?.sections
      .find((r: { kind: string }) => r.kind === 'personal')
      ?.paragraphs.join(' '),
  ).toContain('довгу роботу без перерв');
  expect(data.report?.details?.personalPeriods?.current?.patterns).toMatchObject({
    energy: { pairs: 4 },
  });
  expect(JSON.stringify(data)).not.toContain('stress');
  expect(s.row.quality_json).toBe(original);
  expect(s.legacyRead).not.toHaveBeenCalled();
});
it('keeps original evidence when historical answers no longer match the saved metrics', async () => {
  const s = setup();
  s.checkins['2026-10-19']!.evening = {
    confirmed: true,
    questionVersion: 3,
    energy: 5,
    energyFactorsV3: ['stress'],
  };
  const data = await readWeeklyReports(s.env);
  expect(data.report?.details?.personalPeriods?.current?.patterns).toBeNull();
  expect(JSON.stringify(data.report?.analysis)).toContain('обмеження старого звіту');
  expect(JSON.stringify(data.report?.analysis)).not.toContain('довгу роботу без перерв');
});
it('uses stored patterns without another personal-data read and tolerates unavailable archival data', async () => {
  const current = setup(true);
  await readWeeklyReports(current.env);
  expect(current.peek).not.toHaveBeenCalled();
  const old = setup();
  old.peek.mockRejectedValueOnce(new Error('unavailable'));
  expect((await readWeeklyReports(old.env)).report?.id).toBe('saved');
  expect(old.legacyRead).not.toHaveBeenCalled();
});
it('keeps the saved text readable when legacy quality metadata is JSON null', async () => {
  const s = setup();
  s.row.quality_json = 'null';
  const data = await readWeeklyReports(s.env);
  expect(data.report?.text).toBe(s.row.text_md);
  expect(data.report?.analysis).toBeNull();
});
