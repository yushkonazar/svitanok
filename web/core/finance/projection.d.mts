import type { SavingsForecast } from './savings-forecast.mjs';
export interface ProjectionDay {
  date: string;
  income: number;
  taxi: number;
  payment: number;
  expense: number;
  saving: number;
  balance: number;
  lower: number;
  upper: number;
}
export interface Projection {
  today: string;
  until: string;
  asOf: string;
  algorithmVersion: string;
  available: number;
  obligations: number;
  plannedExpense: number;
  saving: number;
  expectedIncome: number;
  result: number | null;
  conservativeResult: number | null;
  currentSafe: number | null;
  daily: ProjectionDay[];
  minimum: { date: string; amount: number } | null;
  warnings: string[];
  unlinkedPaymentCount: number;
  taxi: {
    date: string;
    count: number;
    status: string;
    reason: string;
    historyPeriods: number;
    estimateMinor: number;
    lowerMinor: number;
    upperMinor: number;
  };
  taxiCovered: boolean;
  plans: {
    id: string;
    name: string;
    purpose: string;
    categories: string[];
    amount: number;
    covered: number;
    goalIds: string[];
    values: number[];
    model: string;
    count: number;
    noise: number;
    status: string;
  }[];
  goalPlans: SavingsForecast[];
  incomes: { name: string; date: string; amount: number; source?: string }[];
  payments: {
    date: string;
    payment: number;
    remaining: number | null;
    id: string;
    name: string;
    category: string;
  }[];
  overlaps: string[];
  incomplete: boolean;
  hasPlans: boolean;
}
export function projectFinances(finance: any, days: number, nowMs?: number): Projection;
