import { it, expect } from 'vitest';
import { readFinanceDemo, resetFinanceDemo } from '../api/finance-demo.ts';
import { financeForecast } from './financeForecast.ts';
import { budgetRows, budgetLimit } from './budgetPlanning.ts';
const now = Date.parse('2026-10-10T12:00:00Z');
function data() {
  resetFinanceDemo();
  const f = readFinanceDemo();
  f.accounts = [
    {
      id: 'cash',
      name: 'Готівка',
      kind: 'cash',
      currency: 'UAH',
      balanceMinor: 1000000,
      asOf: null,
      monoId: null,
      source: 'manual',
    },
  ];
  f.transactions = [];
  f.goalMoves = [];
  f.goals = [];
  f.payments = [];
  f.budgets = [];
  f.reserveMinor = 0;
  f.taxiWeeks = [];
  f.forecast = { incomes: [] };
  return f;
}
it('forecasts only remaining expenses, keeps past spending out of deductions, and avoids harmonic day allocation', () => {
  const f = data();
  f.budgets = [
    {
      id: 'food',
      category: 'Їжа',
      categories: ['продукти'],
      purpose: 'expense',
      period: 'month',
      limitMinor: 310000,
      shareBps: null,
      incomeBaseMinor: null,
      forecastEnabled: true,
    },
  ];
  f.transactions = [
    {
      id: 'old',
      at: '2026-10-09T12:00:00Z',
      amountMinor: -90000,
      amountUah: -90000,
      currency: 'UAH',
      kind: 'expense',
      category: 'продукти',
      description: 'Продукти',
      accountId: 'cash',
      bank: false,
      reference: null,
    },
  ];
  const r = financeForecast(f, 7, now);
  expect(r.plannedExpense).toBe(70000);
  expect(r.result).toBe(930000);
});
it('does not add a child plan twice and converts monthly shares to the daily period', () => {
  const f = data();
  f.budgets = [
    {
      id: 'root',
      category: 'Основне',
      categories: ['продукти'],
      purpose: 'expense',
      period: 'month',
      limitMinor: 310000,
      shareBps: null,
      incomeBaseMinor: null,
      forecastEnabled: true,
    },
    {
      id: 'child',
      parentId: 'root',
      category: 'На день',
      categories: ['продукти'],
      purpose: 'expense',
      period: 'day',
      limitMinor: null,
      shareBps: 10000,
      incomeBaseMinor: 0,
      forecastEnabled: true,
    },
  ];
  expect(budgetLimit(f.budgets[1], f.budgets, '2026-10-10')).toBe(10000);
  expect(financeForecast(f, 7, now).plannedExpense).toBe(Math.round((310000 / 22) * 7));
});
it('payments inside a budget are counted once, external goal moves reduce planned contributions and targeted saving counts only its goal', () => {
  const f = data();
  f.budgets = [
    {
      id: 'services',
      category: 'Сервіси',
      categories: ['цифрові сервіси'],
      purpose: 'expense',
      period: 'day',
      limitMinor: 10000,
      shareBps: null,
      incomeBaseMinor: null,
      forecastEnabled: true,
    },
    {
      id: 'saving',
      category: 'Банка',
      categories: [],
      purpose: 'saving',
      period: 'week',
      limitMinor: 70000,
      shareBps: null,
      incomeBaseMinor: null,
      goalId: 'goal',
      forecastEnabled: true,
    },
  ];
  f.payments = [
    {
      id: 'sub',
      name: 'Підписка',
      kind: 'subscription',
      amountMinor: 5000,
      remainingMinor: null,
      installmentsLeft: null,
      nextDate: '2026-10-10',
      anchorDay: 10,
      recurrence: 'once',
      category: 'цифрові сервіси',
      remindDays: 3,
      status: 'active',
    },
  ];
  f.goals = [
    {
      id: 'goal',
      name: 'Банка',
      targetMinor: 100000,
      deadline: null,
      status: 'active',
      planAmountMinor: 70000,
      planPeriod: 'week',
    },
    { id: 'other', name: 'Інша', targetMinor: 100000, deadline: null, status: 'active' },
  ];
  f.goalMoves = [
    {
      id: 'move',
      goalId: 'goal',
      accountId: 'cash',
      amountMinor: 30000,
      at: '2026-10-09T12:00:00Z',
      movementKind: 'external',
    },
    {
      id: 'other',
      goalId: 'other',
      accountId: 'cash',
      amountMinor: 10000,
      at: '2026-10-09T12:00:00Z',
      movementKind: 'external',
    },
  ];
  const r = financeForecast(f, 2, now);
  expect(r.obligations).toBe(5000);
  expect(r.plannedExpense).toBe(15000);
  expect(r.saving).toBe(40000);
  expect(budgetRows(f, now).find((b) => b.id === 'saving')?.spent).toBe(30000);
  expect(r.result).toBe(940000);
});
it('spans new periods, shows overspending, adds only dated future income and refuses ambiguous overlap or unknown balances', () => {
  const f = data();
  f.budgets = [
    {
      id: 'day',
      category: 'Щодня',
      categories: ['продукти'],
      purpose: 'expense',
      period: 'day',
      limitMinor: 10000,
      shareBps: null,
      incomeBaseMinor: null,
      forecastEnabled: true,
    },
  ];
  f.forecast.incomes = [
    {
      id: 'income',
      name: 'Зарплата',
      amountMinor: 100000,
      nextDate: '2026-10-12',
      recurrence: 'week',
    },
  ];
  expect(financeForecast(f, 7, now).result).toBe(1030000);
  f.budgets.push({ ...f.budgets[0], id: 'overlap', category: 'Контроль' });
  expect(financeForecast(f, 7, now).result).toBeNull();
  f.budgets = [];
  f.accounts[0].balanceMinor = null;
  expect(financeForecast(f, 7, now).result).toBeNull();
});
