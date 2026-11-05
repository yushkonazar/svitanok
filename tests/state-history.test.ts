import { describe, expect, it } from 'vitest';
import {
  appendStateArchive,
  stateHistoryMonths,
  stateHistorySeries,
} from '../web/core/checkin/state-history.mjs';
import { monthlyRollup, mergeArchive } from '../web/stats-archive.mjs';
import { emptyStore } from '../web/stats-core.mjs';
const confirmed = (fields: Record<string, unknown> = {}) => ({
  confirmed: true,
  questionVersion: 4,
  ...fields,
});
function month(key: string, rows: Record<string, Record<string, unknown>>[]) {
  const bucket: { month: string } & KvBlob = { month: key };
  rows.forEach((row, i) =>
    appendStateArchive(bucket, `${key}-${String(i + 1).padStart(2, '0')}`, row),
  );
  return bucket;
}
describe('long state history', () => {
  it('keeps saved names, categories and former names per stable option id', () => {
    const bucket = month('2026-10', [
      {
        evening: confirmed({
          moodFactorsV4: ['user_custom'],
          optionLabelsV4: { moodFactorsV4: { user_custom: 'Люди :: Побачення' } },
        }),
      },
      {
        evening: confirmed({
          moodFactorsV4: ['user_custom'],
          optionLabelsV4: { moodFactorsV4: { user_custom: 'Особисте :: Наш вечір' } },
        }),
      },
    ]);
    expect(bucket.observationsV3.metrics['evening.moodFactorsV4']).toMatchObject({
      n: 2,
      counts: { user_custom: 2 },
      labels: { user_custom: 'Особисте :: Наш вечір' },
      labelCounts: { user_custom: { 'Люди :: Побачення': 1, 'Особисте :: Наш вечір': 1 } },
    });
    expect(bucket.observationsV3).toMatchObject({
      days: 2,
      confirmedSlots: 2,
      from: '2026-10-01',
      to: '2026-10-02',
    });
  });
  it('counts free text without retaining its contents and ignores drafts and old scales', () => {
    const bucket = month('2026-10', [
      {
        morning: confirmed({ priorityTextV4: 'Приватний текст справи' }),
        evening: confirmed({ newPriorityV4: 'Інший приватний текст' }),
      },
      { morning: { confirmed: false, questionVersion: 4, energy: 5 } },
      { morning: { confirmed: true, questionVersion: 2, energy: 4 } },
    ]);
    const serialized = JSON.stringify(bucket);
    expect(serialized).not.toContain('Приватний');
    expect(serialized).not.toContain('приватний');
    expect(bucket.observationsV3.days).toBe(1);
    expect(bucket.observationsV3.metrics['evening.newPriorityV4']).toMatchObject({
      n: 1,
      counts: {},
      numericN: 0,
    });
  });
  it('builds a weighted all-time mean rather than an average of monthly means', () => {
    const a = month('2025-12', [{ evening: confirmed({ satisfactionV4: 1 }) }]);
    const b = month(
      '2026-10',
      Array.from({ length: 9 }, () => ({ evening: confirmed({ satisfactionV4: 5 }) })),
    );
    expect(stateHistorySeries([a, b], 'satisfaction', '2026-11-05')).toMatchObject({
      value: 4.6,
      n: 10,
      from: '2025-12',
      to: '2026-10',
    });
    expect(stateHistorySeries([a, b], 'satisfaction', '2026-11-05', 'year')).toMatchObject({
      value: 5,
      n: 9,
    });
  });
  it('balances morning/day/evening using all their counts across months', () => {
    const a = month('2026-09', [
      { morning: confirmed({ energy: 1 }), evening: confirmed({ energy: 5 }) },
    ]);
    const b = month(
      '2026-10',
      Array.from({ length: 3 }, () => ({ morning: confirmed({ energy: 5 }) })),
    );
    const result = stateHistorySeries([a, b], 'energy', '2026-11-05');
    expect(result.n).toBe(5);
    expect(result.value).toBe(4.5);
  });
  it('retains sleepless nights as zero, not unknown sleep or old generic averages', () => {
    const a = month('2026-10', [
      { morning: confirmed({ sleepModeV4: 'none' }) },
      { morning: confirmed({ sleepModeV4: 'main', sleepMinutesV4: 480 }) },
      { morning: confirmed({ sleepModeV4: 'unknown' }) },
    ]);
    const legacy = { month: '2026-09', sleepAvg: 9 };
    expect(stateHistorySeries([a, legacy], 'sleep', '2026-11-05')).toMatchObject({
      value: 4,
      n: 2,
    });
    expect(stateHistorySeries([legacy], 'sleep', '2026-11-05').series[0]?.value).toBeNull();
  });
  it('does not overwrite sealed months with a partial raw window or mutate the archive', () => {
    const old = month(
      '2026-09',
      Array.from({ length: 20 }, () => ({ morning: confirmed({ energy: 5 }) })),
    );
    const before = JSON.stringify(old);
    const result = stateHistoryMonths(
      [old],
      { '2026-09-30': { morning: confirmed({ energy: 1 }) } },
      '2026-09-25',
      '2026-11-05',
    );
    expect(result[0]).toEqual(old);
    expect(JSON.stringify(old)).toBe(before);
  });
  it('only supplies fully covered historical months, while the current month can grow', () => {
    const records = {
      '2026-09-30': { morning: confirmed({ energy: 1 }) },
      '2026-10-02': { morning: confirmed({ energy: 4 }) },
      '2026-11-05': { morning: confirmed({ energy: 5 }) },
    };
    expect(stateHistoryMonths([], records, '2026-09-25', '2026-11-05').map((m) => m.month)).toEqual(
      ['2026-10', '2026-11'],
    );
  });
  it('keeps a richer current archive when the client has stale or incomplete records', () => {
    const archive = month('2026-11', [
      { morning: confirmed({ energy: 4 }) },
      { morning: confirmed({ energy: 5 }) },
    ]);
    const result = stateHistoryMonths(
      [archive],
      { '2026-11-01': { morning: confirmed({ energy: 1 }) } },
      '2026-08-01',
      '2026-11-05',
    );
    expect(result[0]).toEqual(archive);
  });
  it('integrates with the server rollup without rewriting prior sealed archive months', () => {
    const store = emptyStore();
    store.checkins = {
      '2026-10-01': {
        evening: confirmed({
          moodFactorsV4: ['user_name'],
          optionLabelsV4: { moodFactorsV4: { user_name: 'Особисте :: Назва' } },
        }),
      },
    };
    const fresh = monthlyRollup(store, '2026-11-05');
    expect(fresh['2026-10'].observationsV3.metrics['evening.moodFactorsV4'].labels.user_name).toBe(
      'Особисте :: Назва',
    );
    const previous = { '2026-10': { month: '2026-10', checkinDays: 30 } };
    expect(mergeArchive(previous, fresh, '2026-11-05')['2026-10']).toEqual(previous['2026-10']);
  });
});
