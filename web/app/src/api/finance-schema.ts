import { z } from 'zod';

const money = z.number().int().safe();
export const financeAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['cash', 'bank', 'mono']),
  currency: z.string(),
  balanceMinor: money.nullable(),
  availableMinor: money.nullable().optional(),
  creditLimitMinor: money.nullable().optional(),
  creditLimitSource: z.string().optional(),
  asOf: z.string().nullable(),
  monoId: z.string().nullable(),
  source: z.string(),
});
export const financeTxSchema = z.object({
  id: z.string(),
  at: z.string(),
  amountMinor: money,
  currency: z.string(),
  amountUah: money.nullable(),
  category: z.string(),
  description: z.string(),
  kind: z.string(),
  accountId: z.string().nullable(),
  bank: z.boolean(),
  bankHold: z.boolean().optional(),
  reference: z.string().nullable(),
  personalTaxiType: z.string().nullable().optional(),
});
export const taxiPolicySchema = z.object({
  id: z.string(),
  effectiveAt: z.string(),
  fareBps: z.number().int(),
  commissionBps: z.number().int(),
  fuelBps: z.number().int(),
  tipsBps: z.number().int().min(0).max(10000).default(5000),
  thresholdMinor: money.nullable(),
  bonusFareBps: z.number().int(),
});
export const taxiEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  policyId: z.string(),
  netCashMinor: money,
  commissionMinor: money,
  fuelMinor: money,
  tipsMinor: money,
  directMinor: money,
  receivedCashMinor: money,
  paidWorkMinor: money,
  commissionReported: z.boolean().default(true),
  cashReported: z.boolean().default(true),
  accountId: z.string().nullable(),
  note: z.string(),
  revision: z.number().int(),
});
export const financeGoalSchema = z.object({
  id: z.string(),
  name: z.string(),
  targetMinor: money,
  deadline: z.string().nullable(),
  status: z.string(),
});
export const financeBudgetSchema = z.object({
  id: z.string(),
  category: z.string(),
  categories: z.array(z.string()),
  purpose: z.enum(['expense', 'saving']),
  period: z.enum(['day', 'week', 'month']),
  limitMinor: money.nullable(),
  shareBps: z.number().int().nullable(),
  incomeBaseMinor: money.nullable(),
});
export const financePaymentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['subscription', 'loan', 'installment', 'card-installment', 'bill']),
  amountMinor: money,
  remainingMinor: money.nullable(),
  installmentsLeft: z.number().int().nullable(),
  nextDate: z.string(),
  anchorDay: z.number().int(),
  recurrence: z.enum(['month', 'year', 'once']),
  category: z.string(),
  remindDays: z.number().int(),
  status: z.string(),
  totalMinor: money.nullable().optional(),
  rateBps: z.number().int().min(0).max(30000).optional(),
  feeMinor: money.optional(),
  lender: z.string().optional(),
  note: z.string().optional(),
});
export const financeSchema = z.object({
  ok: z.literal(true),
  version: z.number().int(),
  generatedAt: z.string(),
  settings: z.object({
    incomePeriod: z.enum(['week', 'month']),
    taxiVisible: z.boolean(),
    paymentReminders: z.boolean().default(true),
    checkinReminders: z.boolean().default(true),
  }),
  categories: z.array(z.string()),
  accounts: z.array(financeAccountSchema),
  transactions: z.array(financeTxSchema),
  policies: z.array(taxiPolicySchema),
  taxiEntries: z.array(taxiEntrySchema),
  taxiWeeks: z.array(
    z.object({
      key: z.string(),
      grossMinor: money,
      earnedMinor: money,
      heldMinor: money,
      settlementMinor: money,
      complete: z.boolean().default(true),
      settled: z.boolean(),
      closed: z.boolean(),
    }),
  ),
  settlements: z.array(
    z.object({
      id: z.string(),
      weekKey: z.string(),
      amountMinor: money,
      accountId: z.string(),
      at: z.string(),
    }),
  ),
  reserveMinor: money,
  goals: z.array(financeGoalSchema),
  goalMoves: z.array(
    z.object({
      id: z.string(),
      goalId: z.string(),
      accountId: z.string(),
      amountMinor: money,
      at: z.string(),
    }),
  ),
  budgets: z.array(financeBudgetSchema),
  payments: z.array(financePaymentSchema),
  detectedSubscriptions: z.array(
    z.object({
      id: z.string(),
      merchant: z.string(),
      amountMinor: money,
      currency: z.string(),
      nextAt: z.string().nullable(),
    }),
  ),
});
export type Finance = z.infer<typeof financeSchema>;
export interface FinanceCommand {
  id: string;
  version: number;
  type: string;
  payload: Record<string, unknown>;
}
