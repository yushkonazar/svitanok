export function budgetPeriod(
  period: string,
  date: string,
): { start: string; end: string; days: number };
export function budgetPlanLimit(b: any, budgets: any[], date: string, seen?: Set<string>): number;
export function budgetDefinitionAt(finance: any, budgetId: string, date: string): any | null;
