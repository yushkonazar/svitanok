import { describe, expect, it } from 'vitest';
import { analyticsSelection, buildExpenseAnalytics } from '../web/core/finance/analytics.mjs';
import { findWeatherWindow, weatherWindowLabel } from '../web/app/src/lib/weatherWindow.ts';
import { todaySpendingInsight, todaySpendingRequest } from '../web/app/src/lib/todaySpending.ts';
import { historyPlaceVisible } from '../web/app/src/lib/historyMap.ts';

describe('Today comparable spending', () => {
  const now = Date.parse('2026-10-27T10:30:00Z'); // 12:30 Kyiv, following the DST change.
  const selection = analyticsSelection(new URLSearchParams({ ...todaySpendingRequest(now) }), now);
  const tx = (id: string, at: string, amountUah: number | null, extra = {}) => ({
    id,
    at,
    amountUah,
    amountMinor: amountUah ?? -100,
    currency: 'UAH',
    kind: 'expense',
    category: 'продукти',
    description: id,
    ...extra,
  });
  it('compares the same weekdays and Kyiv cutoff across DST, excluding future and pending entries', () => {
    expect(selection.previousFrom).toBe('2026-10-19');
    expect(selection.previousTo).toBe('2026-10-20');
    expect(selection.previousPeriod?.to).toBe('2026-10-20T09:30:00.001Z');
    const result = buildExpenseAnalytics(
      [
        tx('current', '2026-10-27T10:29:00Z', -10000),
        tx('current-future', '2026-10-27T10:31:00Z', -50000),
        tx('previous', '2026-10-20T09:29:00Z', -20000),
        tx('previous-later', '2026-10-20T09:31:00Z', -60000),
        tx('pending', '2026-10-27T10:28:00Z', -90000, { bankHold: true }),
        tx('wrong-weekday', '2026-10-25T10:29:00Z', -80000),
      ],
      selection,
    );
    expect(result.summary.expenseMinor).toBe(10000);
    expect(result.summary.previousExpenseMinor).toBe(20000);
    expect(result.summary.changeBps).toBe(-5000);
    expect(() =>
      analyticsSelection(
        new URLSearchParams({ from: '2026-10-01', to: '2026-10-27', comparison: 'week' }),
        now,
      ),
    ).toThrow();
  });
  it('withholds a percentage for incomplete history, zero baseline, or uncertain entries in either period', () => {
    const result = buildExpenseAnalytics(
      [tx('current', '2026-10-27T10:29:00Z', -10000)],
      selection,
    );
    const data = {
      ...result,
      coverage: {
        bankRetentionDays: 720,
        oldestTransactionAt: '2026-10-27T10:29:00Z',
        previousBeforeFirstRecord: false,
        beyondBankRetention: false,
      },
    };
    expect(todaySpendingInsight(data).change).toBeNull();
    data.coverage.oldestTransactionAt = '2026-10-01T10:00:00Z';
    expect(todaySpendingInsight(data)).toMatchObject({ covered: true, change: null });
    const uncertain = buildExpenseAnalytics(
      [
        tx('current', '2026-10-27T10:29:00Z', -10000),
        tx('previous', '2026-10-20T09:29:00Z', -20000),
        tx('unknown-previous', '2026-10-20T08:00:00Z', null),
      ],
      selection,
    );
    expect(todaySpendingInsight({ ...data, ...uncertain })).toMatchObject({
      comparable: false,
      change: null,
      driver: null,
    });
  });
  it('explains the category contributing most in the direction of the total change', () => {
    const result = buildExpenseAnalytics(
      [
        tx('food-now', '2026-10-27T10:00:00Z', -30000),
        tx('food-before', '2026-10-20T09:00:00Z', -50000),
        tx('fuel-now', '2026-10-27T10:00:00Z', -15000, { category: 'авто' }),
        tx('fuel-before', '2026-10-20T09:00:00Z', -10000, { category: 'авто' }),
      ],
      selection,
    );
    const insight = todaySpendingInsight({
      ...result,
      coverage: {
        bankRetentionDays: 720,
        oldestTransactionAt: '2026-10-01T10:00:00Z',
        previousBeforeFirstRecord: false,
        beyondBankRetention: false,
      },
    });
    expect(insight.change).toBe(-2500);
    expect(insight.driver).toMatchObject({ category: 'продукти', deltaMinor: -20000 });
  });
});

describe('Forecast window', () => {
  const now = Date.parse('2026-11-03T08:00:00Z'); // 10:00 Kyiv.
  const hour = (offset: number, popPercent?: number) => ({
    h: 10 + offset,
    at: now / 1000 + offset * 3600,
    t: 10 + offset,
    popPercent,
    precipMm: 0,
  });
  it('selects the nearest equally dry interval and reports the conservative maximum probability', () => {
    const window = findWeatherWindow(
      [hour(0, 80), hour(1, 30), hour(2, 10), hour(3, 30), hour(4, 50)],
      now,
    )!;
    expect(window).toMatchObject({
      from: hour(1).at,
      to: hour(2).at,
      probability: 30,
      minC: 11,
      maxC: 12,
    });
    expect(weatherWindowLabel(window, now)).toBe('Сьогодні 11:00–12:00');
    expect(weatherWindowLabel(findWeatherWindow([hour(0, 0), hour(1, 0)], now)!, now)).toBe(
      'Зараз–11:00',
    );
  });
  it('does not use expired, untimed, unknown or missing forecast intervals', () => {
    expect(findWeatherWindow([hour(-2, 0), hour(-1, 0)], now)).toBeNull();
    expect(
      findWeatherWindow(
        [
          { h: 11, t: 10, popPercent: 0 },
          { h: 12, t: 11, popPercent: 0 },
        ],
        now,
      ),
    ).toBeNull();
    expect(findWeatherWindow([hour(0, 0), hour(1), hour(2, 0)], now)).toBeNull();
    expect(
      findWeatherWindow([hour(0, 100), hour(1, 100), hour(4, 0), hour(7, 0)], now)?.probability,
    ).toBe(100);
    expect(findWeatherWindow([hour(25, 0), hour(26, 0)], now)).toBeNull();
  });
  it('labels tomorrow across midnight and does not call a wet forecast dry', () => {
    const late = Date.parse('2026-11-03T20:00:00Z');
    const points = [hour(13, 90), hour(14, 80), hour(15, 85)].map((point) => ({
      ...point,
      h: point.h % 24,
    }));
    const window = findWeatherWindow(points, late)!;
    expect(window.probability).toBe(85);
    expect(weatherWindowLabel(window, late)).toBe('Завтра 00:00–01:00');
  });
});

it('keeps the map camera still for a visible point and recognises wrapped longitudes', () => {
  const europe = { x: 180, y: 25, width: 70, height: 35 };
  expect(historyPlaceVisible(europe, { lat: 50, lon: 30 })).toBe(true);
  expect(historyPlaceVisible(europe, { lat: 36, lon: 139 })).toBe(false);
  expect(
    historyPlaceVisible({ x: 340, y: 65, width: 40, height: 20 }, { lat: 15, lon: -175 }),
  ).toBe(true);
});
