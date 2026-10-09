export function bankPaymentAmount(tx: {
  bank: boolean;
  amountUah: number | null;
  amountMinor: number;
  currency: string;
}): number | null;
