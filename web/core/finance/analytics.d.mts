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
  period?: {
    from: string;
    to: string;
    dateFrom: string;
    dateTo: string;
    asOf: string;
    timeZone: string;
    complete: boolean;
  };
  previousPeriod?: {
    from: string;
    to: string;
    dateFrom: string;
    dateTo: string;
    asOf: string;
    timeZone: string;
    complete: boolean;
  };
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
  bankMissingFromStatement?: boolean;
  bankCheckedAt?: string | null;
  bankCheckSource?: string | null;
  reference?: string | null;
  principalMinor?: number | null;
  overpaymentMinor?: number | null;
  flags?: string[];
  attention?: { status: string } | null;
}
export interface ExpenseAnalytics {
  selection: AnalyticsSelection;
  sourceTotals: {
    mono: { expenseMinor: number; count: number };
    manual: { expenseMinor: number; count: number };
  };
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
    previousCount: number;
    previousMinor: number;
    deltaMinor: number;
  }[];
  merchants: {
    merchant: string;
    amountMinor: number;
    count: number;
    previousCount: number;
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
    unclassifiedOutflowMinor: number;
    unclassifiedInflowMinor: number;
    unclassifiedUnknownCurrencyCount: number;
    unknownCurrencyCount: number;
    pendingCount: number;
    pendingMinor: number;
    possibleDuplicateCount: number;
    resolvedDuplicateCount: number;
    invalidDirectionCount: number;
    amountChangedCount: number;
  };
}
export function analyticsSelection(params: URLSearchParams, nowMs?: number): AnalyticsSelection;
export function merchantName(name: string, aliases?: Record<string, string>): string;
export function validateMerchantAliases(input: unknown): Record<string, string>;
export function matchesAnalyticsIssue(tx: AnalyticsTransaction, issue?: string): boolean;
export function matchesAnalytics(
  tx: AnalyticsTransaction,
  s: AnalyticsSelection,
  aliases?: Record<string, string>,
): boolean;
export function analyticsAccumulator(
  s: AnalyticsSelection,
  aliases?: Record<string, string>,
  catalog?: boolean,
): {
  consume: (tx: AnalyticsTransaction) => void;
  finish: () => ExpenseAnalytics;
};
export function buildExpenseAnalytics(
  tx: AnalyticsTransaction[],
  s: AnalyticsSelection,
  aliases?: Record<string, string>,
): ExpenseAnalytics;
