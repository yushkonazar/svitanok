import { expect, it } from 'vitest';
import { adaptiveForecast } from '../web/core/finance/adaptive-model.mjs';
import { savingsForecast } from '../web/core/finance/savings-forecast.mjs';
import { projectFinances } from '../web/core/finance/projection.mjs';
import type { TaxiEntry, TaxiPolicy } from '../web/core/finance/planning.mjs';
import { taxiWeek, shiftDate, kyivInstant } from '../web/core/finance/planning.mjs';
import {
  financeDisplay,
  isTerminalTopup,
  recommendThresholds,
} from '../web/core/finance/display.mjs';
const now = Date.parse('2026-10-12T09:00:00Z');
it('keeps unlinked historical installment debits out of everyday spending forecasts and asks to reconcile the schedule', () => {
  const f = fixture();
  f.transactions = [
    {
      at: '2026-10-07T10:00:00Z',
      kind: 'expense',
      amountUah: -50000,
      category: 'покупка частинами',
    },
  ] as typeof f.transactions;
  f.payments = [
    {
      id: 'debt',
      name: 'Договір',
      kind: 'card-installment',
      amountMinor: 50000,
      remainingMinor: 100000,
      overpaymentRemainingMinor: 0,
      installmentsLeft: 2,
      nextDate: '2026-10-14',
      anchorDay: 14,
      recurrence: 'month',
      category: 'розстрочка',
      status: 'active',
    },
  ];
  const p = projectFinances(f, 7, now);
  expect(p.obligations).toBe(50000);
  expect(p.plannedExpense).toBe(0);
  expect(p.result).toBe(950000);
  expect(p.warnings.some((w) => w.includes('прив’язки до договору'))).toBe(true);
});
const policy = {
  id: 'p',
  effectiveAt: '2026-01-01T00:00:00Z',
  fareBps: 5000,
  commissionBps: 5000,
  fuelBps: 5000,
  tipsBps: 5000,
  thresholdMinor: null,
  bonusFareBps: 5500,
};
function fixture() {
  return {
    accounts: [
      { id: 'cash', kind: 'cash', currency: 'UAH', balanceMinor: 1000000 as number | null },
    ],
    transactions: [] as { at: string; kind: string; amountUah: number; category?: string }[],
    taxiEntries: [] as (TaxiEntry & { dayComplete?: boolean })[],
    taxiWeeks: [] as (ReturnType<typeof taxiWeek> & {
      closed: boolean;
      complete: boolean;
      settled: boolean;
    })[],
    policies: [] as TaxiPolicy[],
    settlements: [] as { weekKey: string }[],
    goals: [] as (typeof goal & { planStartedAt?: string })[],
    goalMoves: [] as { goalId: string; at: string; amountMinor: number }[],
    budgets: [] as Record<string, unknown>[],
    payments: [] as Record<string, unknown>[],
    forecast: { incomes: [] },
    reserveMinor: 0,
  };
}
const goal = {
  id: 'g',
  name: 'Ціль',
  targetMinor: 10000000,
  status: 'active',
  planAmountMinor: 350000,
  planPeriod: 'week',
  deadline: null,
};
it('learns weekly variation on chronological folds and adapts its level without treating missing days as zero', () => {
  const values = Array.from(
    { length: 84 },
    (_, i) => [10000, 10000, 10000, 10000, 10000, 100000, 100000][i % 7]!,
  );
  const result = adaptiveForecast(values, 7, 0);
  expect(result.scores.every((s) => s.folds === 9)).toBe(true);
  expect(result.model).toBe('kalman-weekly');
  expect(result.points[5]).toBeGreaterThan(result.points[0]! * 2);
  const missing = adaptiveForecast([10000, null, null, null, null], 2);
  const zeros = adaptiveForecast([10000, 0, 0, 0, 0], 2);
  expect(missing.count).toBe(1);
  expect(missing.points[0]).toBe(10000);
  expect(zeros.points[0]).toBeLessThan(5000);
  const changed = adaptiveForecast([...Array(60).fill(10000), ...Array(14).fill(30000)], 7);
  expect(changed.points[0]).toBeGreaterThan(25000);
  expect(changed.points.every(Number.isSafeInteger)).toBe(true);
});
it('carries the first partial contribution and adapts repeated shortfalls while keeping the chosen plan', () => {
  const f = fixture();
  f.goals = [goal];
  f.goalMoves = [{ goalId: 'g', at: '2026-10-07T10:00:00Z', amountMinor: 150000 }];
  const first = savingsForecast(f, 7, now)[0]!;
  expect(first).toMatchObject({ target: 350000, gap: 200000, adaptive: false, amount: 550000 });
  expect(first.events[0]).toMatchObject({
    date: '2026-10-14',
    earliest: '2026-10-12',
    latest: '2026-10-18',
  });
  f.goalMoves.push({ goalId: 'g', at: '2026-10-15T10:00:00Z', amountMinor: 150000 });
  const repeated = savingsForecast(f, 7, now + 7 * 86400000)[0]!;
  expect(repeated).toMatchObject({ target: 350000, gap: 400000, adaptive: true, amount: 150000 });
  expect(repeated.events[0]!.planned).toBe(750000);
  expect(f.goals[0]!.planAmountMinor).toBe(350000);
  expect(JSON.stringify(repeated)).not.toMatch(/overdue|dueDate/);
});
it('does not invent historic shortfalls when the user changes the contribution plan', () => {
  const f = fixture();
  f.goals = [{ ...goal, planStartedAt: '2026-10-12T08:00:00Z' }];
  f.goalMoves = [{ goalId: 'g', at: '2026-09-01T10:00:00Z', amountMinor: 100000 }];
  expect(savingsForecast(f, 7, now)[0]).toMatchObject({
    gap: 0,
    amount: 350000,
    remaining: 9900000,
  });
});
it('keeps a flexible monthly contribution inside its real calendar month', () => {
  const f = fixture();
  f.goals = [{ ...goal, planPeriod: 'month' }];
  expect(savingsForecast(f, 31, now)[0]!.events[0]!.latest).toBe('2026-10-31');
});
it('includes an earlier flexible contribution in the cautious scenario without forcing it into a Wednesday deadline', () => {
  const f = fixture();
  f.goals = [goal];
  const p = projectFinances(f, 2, now);
  expect(p.saving).toBe(0);
  expect(p.daily[0]!.lower).toBe(650000);
  expect(p.daily[1]!.upper).toBe(1000000);
});
function taxiFixture(net: number, cash: number) {
  const f = fixture();
  f.policies = [policy];
  const entry = {
    id: 'e',
    at: '2026-10-11T18:00:00Z',
    policyId: 'p',
    netCashMinor: net,
    commissionMinor: 0,
    fuelMinor: 0,
    tipsMinor: 0,
    directMinor: 0,
    receivedCashMinor: cash,
    paidWorkMinor: 0,
    commissionReported: true,
    cashReported: true,
  };
  f.taxiEntries = [
    entry,
    {
      ...entry,
      id: 'done',
      at: '2026-10-12T07:00:00Z',
      netCashMinor: 0,
      receivedCashMinor: 0,
      dayComplete: true,
    },
  ];
  const week = taxiWeek(Date.parse(entry.at), [policy]);
  f.taxiWeeks = [{ ...week, closed: true, complete: true, settled: false }];
  f.accounts[0]!.balanceMinor = cash;
  f.reserveMinor = Math.max(0, cash - net / 2);
  return f;
}
it('releases the park reserve at handover without spending it or adding passengers cash twice', () => {
  const f = taxiFixture(20000, 30000);
  const p = projectFinances(f, 1, now);
  expect(p.available).toBe(10000);
  expect(p.expectedIncome).toBe(0);
  expect(p.result).toBe(10000);
  const positive = projectFinances(taxiFixture(80000, 10000), 1, now);
  expect(positive.expectedIncome).toBe(30000);
  expect(positive.result).toBe(40000);
});
it('does not forecast a second workday after a completed shift; explicit partial days may have a remainder', () => {
  const f = fixture();
  f.policies = [policy];
  f.taxiEntries = Array.from({ length: 28 }, (_, i) => ({
    id: String(i),
    at: new Date(kyivInstant(shiftDate('2026-10-12', -i), 8)).toISOString(),
    policyId: 'p',
    netCashMinor: 100000,
    commissionMinor: 0,
    fuelMinor: 0,
    tipsMinor: 0,
    directMinor: 0,
    receivedCashMinor: i === 0 ? 10000 : 50000,
    paidWorkMinor: 0,
    commissionReported: true,
    cashReported: true,
    dayComplete: true,
  }));
  f.settlements = [{ weekKey: taxiWeek(now, [policy]).key }];
  const complete = projectFinances(f, 1, now);
  expect(complete.daily[0]!.taxi).toBe(0);
  f.taxiEntries[0]!.dayComplete = false;
  f.taxiEntries[0]!.netCashMinor = 10000;
  expect(projectFinances(f, 1, now).daily[0]!.taxi).toBeGreaterThan(0);
});
it('counts a scheduled payment once when a sparse expense model falls back to the same category budget', () => {
  const f = fixture();
  f.budgets = [
    { id: 'b', purpose: 'expense', categories: ['сервіси'], period: 'day', limitMinor: 10000 },
  ];
  f.payments = [
    {
      id: 'p',
      name: 'Сервіс',
      kind: 'subscription',
      amountMinor: 5000,
      remainingMinor: null,
      installmentsLeft: null,
      nextDate: '2026-10-12',
      anchorDay: 12,
      recurrence: 'once',
      category: 'сервіси',
      status: 'active',
    },
  ];
  const p = projectFinances(f, 2, now);
  expect(p.obligations).toBe(5000);
  expect(p.plannedExpense).toBe(15000);
  expect(p.result).toBe(980000);
});
it('does not multiply a sparse fallback envelope by its category count and preserves daily cash identities', () => {
  const f = fixture();
  f.budgets = [
    {
      id: 'b',
      purpose: 'expense',
      categories: ['кафе', 'продукти'],
      period: 'day',
      limitMinor: 35000,
    },
  ];
  f.goals = [goal];
  const p = projectFinances(f, 14, now);
  expect(p.plannedExpense).toBe(490000);
  let balance = p.available;
  for (const day of p.daily) {
    expect(day.balance).toBe(balance + day.income - day.payment - day.expense - day.saving);
    expect(day.lower).toBeLessThanOrEqual(day.balance);
    expect(day.upper).toBeGreaterThanOrEqual(day.balance);
    balance = day.balance;
  }
  expect(p.result).toBe(balance);
  f.accounts[0]!.balanceMinor = null;
  expect(projectFinances(f, 7, now).result).toBeNull();
});
it('validates user thresholds and recognizes only unlinked terminal credits without auto-classifying income', () => {
  expect(() => financeDisplay({ expenseThresholds: [20000, 20000] })).toThrow();
  expect(() => financeDisplay({ expenseThresholds: [10000, -1] })).toThrow();
  const tx = {
    bank: true,
    amountUah: 50000,
    currency: 'UAH',
    description: 'Термінал mono',
    kind: 'unclassified',
    reference: null,
  };
  expect(isTerminalTopup(tx)).toBe(true);
  for (const override of [
    { kind: 'income' },
    { reference: 'linked' },
    { amountUah: -50000 },
    { currency: 'USD' },
    { bankMissingFromStatement: true },
  ])
    expect(isTerminalTopup({ ...tx, ...override })).toBe(false);
  const suggestion = recommendThresholds(
    Array.from({ length: 40 }, (_, i) => ({ kind: 'expense', amountUah: -(i + 1) * 10000 })),
    4,
  );
  expect(suggestion.values).toHaveLength(4);
  expect(new Set(suggestion.values).size).toBe(4);
});
