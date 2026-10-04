export const PAYMENT_KIND_LABELS: Record<string, string>;
export const INTEREST_METHOD_LABELS: Record<string, string>;
export function interestQuote(
  principal: number,
  months: number,
  rateBps: number,
  method: string,
  feeMinor?: number,
  originalPrincipal?: number,
): {
  amountMinor: number;
  totalMinor: number;
  overpaymentMinor: number;
  lastAmountMinor: number;
} | null;
export function interestDebtPayment(
  payment: {
    amountMinor: number;
    remainingMinor: number | null;
    totalMinor?: number | null;
    installmentsLeft?: number | null;
    rateBps?: number;
    feeMinor?: number;
    interestMethod?: string | null;
  },
  paidAmount?: number,
): {
  amountMinor: number;
  principalMinor: number;
  overpaymentMinor: number;
  interestMinor: number;
} | null;
export function isDebtKind(kind: string): boolean;
export function estimateRemaining(
  amountMinor: number,
  count: number,
  feeMinor?: number,
  rateBps?: number,
): number | null;
export function installmentQuote(
  principal: number,
  overpayment: number,
  months: number,
): { totalMinor: number; amountMinor: number; lastAmountMinor: number } | null;
export function fixedDebtPayment(
  payment: {
    amountMinor: number;
    remainingMinor: number | null;
    installmentsLeft?: number | null;
    overpaymentRemainingMinor?: number | null;
  },
  paidAmount?: number,
): { amountMinor: number; principalMinor: number; overpaymentMinor: number } | null;
