export const DEFAULT_THRESHOLDS: number[];
export interface FinanceDisplay {
  expenseThresholds: number[];
  currencyCycle: boolean;
  animations: boolean;
  expenseForecast: 'history' | 'plan';
  savingWeekday: number;
}
export function financeDisplay(value?: unknown): FinanceDisplay;
export function recommendThresholds(
  transactions: any[],
  count?: number,
): { values: number[]; observations: number };
export function isTerminalTopup(tx: any): boolean;
