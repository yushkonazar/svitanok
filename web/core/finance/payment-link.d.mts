export function bankPaymentAmount(tx: {
  bank: boolean;
  amountUah: number | null;
  amountMinor: number;
  currency: string;
}): number | null;

export function needsBankHoldConfirmation(
  tx:
    | {
        bankHold?: boolean;
        bankVerifiedByOwner?: boolean;
        bankAmountChanged?: boolean;
      }
    | null
    | undefined,
): boolean;
