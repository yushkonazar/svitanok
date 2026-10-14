export interface AnalyticsSelection {
  from: string;
  to: string;
  days: number;
  account: string;
  category: string;
  merchant: string;
  source: string;
  status: string;
  comparison: string;
  previousFrom: string;
  previousTo: string;
}
export function analyticsPeriod(
  period: string,
  nowMs?: number,
): { from: string; to: string; comparison: string };
export interface AnalyticsTransaction {
  id: string;
  at: string;
  kind: string;
  category: string;
  description: string;
  amountUah: number | null;
  amountMinor: number;
  currency: string;
  accountId?: string | null;
  bank?: boolean;
  bankHold?: boolean;
  bankVerifiedByOwner?: boolean;
  duplicateSuspected?: boolean;
  bankAmountChanged?: boolean;
}
export interface ExpenseAnalytics {
  selection: AnalyticsSelection;
  summary: {
    expenseMinor: number;
    previousExpenseMinor: number;
    otherIncomeMinor: number;
    count: number;
    operationCount: number;
    medianMinor: number | null;
    averagePaymentMinor: number | null;
    averageDayMinor: number;
    activeDays: number;
    changeMinor: number;
    changeBps: number | null;
    largest: { id: string; description: string; at: string; amountMinor: number } | null;
  };
  categories: {
    category: string;
    amountMinor: number;
    count: number;
    previousMinor: number;
    deltaMinor: number;
  }[];
  merchants: {
    merchant: string;
    amountMinor: number;
    count: number;
    previousMinor: number;
    deltaMinor: number;
  }[];
  merchantCount: number;
  daily: {
    date: string;
    expenseMinor: number;
    incomeMinor: number;
    count: number;
    cumulativeMinor: number;
  }[];
  weekdays: { day: number; days: number; amountMinor: number; averageMinor: number }[];
  quality: {
    unclassifiedCount: number;
    unknownCurrencyCount: number;
    pendingCount: number;
    pendingMinor: number;
    possibleDuplicateCount: number;
    invalidDirectionCount: number;
    amountChangedCount: number;
  };
}
export function analyticsSelection(params: URLSearchParams, nowMs?: number): AnalyticsSelection;
export function matchesAnalytics(tx: AnalyticsTransaction, s: AnalyticsSelection): boolean;
export function analyticsAccumulator(s: AnalyticsSelection): {
  consume: (tx: AnalyticsTransaction) => void;
  finish: () => ExpenseAnalytics;
};
export function buildExpenseAnalytics(
  tx: AnalyticsTransaction[],
  s: AnalyticsSelection,
): ExpenseAnalytics;
