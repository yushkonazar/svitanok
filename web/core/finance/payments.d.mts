export const PAYMENT_KIND_LABELS: Record<string, string>;
export function isDebtKind(kind: string): boolean;
export function estimateRemaining(
  amountMinor: number,
  count: number,
  feeMinor?: number,
  rateBps?: number,
): number | null;
