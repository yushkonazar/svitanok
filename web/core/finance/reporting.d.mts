import type { TaxiEntry, TaxiPolicy } from './planning.mjs';
export interface ReportSource {
  transactions: { at: string; kind: string; amountUah: number | null; category: string }[];
  taxiEntries: TaxiEntry[];
  policies: TaxiPolicy[];
  settlements: {
    weekKey: string;
    amountMinor: number;
    expectedMinor?: number | null;
    at: string;
  }[];
  goalMoves: { at: string; amountMinor: number }[];
}
export interface FinanceReport {
  ok: true;
  from: string;
  to: string;
  generatedAt: string;
  otherIncomeMinor: number;
  expenseMinor: number;
  taxiEarnedMinor: number;
  settlementDifferenceMinor: number;
  resultMinor: number;
  goalContributionsMinor: number;
  unclassifiedCount: number;
  unknownCurrencyCount: number;
  bankRetentionDays: number;
  categories: { category: string; amountMinor: number; count: number }[];
  daily: { date: string; expenseMinor: number; incomeMinor: number }[];
  taxiWeeks: {
    key: string;
    grossMinor: number;
    netCashMinor: number;
    commissionMinor: number;
    fuelMinor: number;
    tipsMinor: number;
    earnedMinor: number;
    heldMinor: number;
    expectedMinor: number;
    actualMinor: number | null;
    differenceMinor: number | null;
    complete: boolean;
    closed: boolean;
  }[];
}
export function validateReportRange(
  from: string,
  to: string,
  nowMs?: number,
): { from: string; to: string; start: number; end: number; days: number };
export function buildFinanceReport(
  state: ReportSource,
  from: string,
  to: string,
  nowMs?: number,
): FinanceReport;
