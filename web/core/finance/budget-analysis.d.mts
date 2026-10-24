export interface BudgetAnalysis {
  id: string;
  name: string;
  period: string;
  points: { date: string; amountMinor: number; planMinor: number | null }[];
  totalMinor: number;
  historyKnown: boolean;
  definitionScope: string;
}
export function budgetAnalysisAccumulator(
  finance: any,
  selection: any,
): { consume(tx: any): void; finish(): BudgetAnalysis[] };
