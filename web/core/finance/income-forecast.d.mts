export function chooseIncomeModel(values: number[]): {
  selected: string;
  folds: number;
  mae: number | null;
  scores: { name: string; mae: number | null }[];
};
export interface TaxiIncomeProjection {
  status: string;
  reason: string;
  date?: string;
  at?: string;
  periodKey?: string;
  historyPeriods?: number;
  pendingMinor?: number;
  currentEarnedMinor?: number;
  heldMinor?: number;
  estimateMinor?: number;
  lowerMinor?: number;
  upperMinor?: number;
  futureEarnedMinor?: number;
  model?: string;
  validation?: ReturnType<typeof chooseIncomeModel>;
}
export function taxiIncomeForecast(finance: any, nowMs: number): TaxiIncomeProjection;
