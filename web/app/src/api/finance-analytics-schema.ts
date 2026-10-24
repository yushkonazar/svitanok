import { z } from 'zod';
import { financeReportSchema, financeTxSchema } from './finance-schema.ts';
const money = z.number().int().safe();
export interface AnalyticsRequest {
  from: string;
  to: string;
  account?: string;
  category?: string;
  merchant?: string;
  source?: 'all' | 'mono' | 'manual';
  status?: 'all' | 'confirmed' | 'pending';
  comparison?: 'adjacent' | 'month';
}
export const financeAnalyticsSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  budgetAnalysis: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        period: z.string(),
        totalMinor: money,
        historyKnown: z.boolean(),
        definitionScope: z.string(),
        points: z.array(
          z.object({ date: z.string(), amountMinor: money, planMinor: money.nullable() }),
        ),
      }),
    )
    .optional(),
  selection: z.object({
    from: z.string(),
    to: z.string(),
    days: z.number().int(),
    account: z.string(),
    category: z.string(),
    merchant: z.string(),
    source: z.string(),
    status: z.string(),
    comparison: z.string(),
    previousFrom: z.string(),
    previousTo: z.string(),
  }),
  summary: z.object({
    expenseMinor: money,
    previousExpenseMinor: money,
    otherIncomeMinor: money,
    count: z.number().int(),
    operationCount: z.number().int(),
    medianMinor: money.nullable(),
    averagePaymentMinor: money.nullable(),
    averageDayMinor: money,
    activeDays: z.number().int(),
    changeMinor: money,
    changeBps: z.number().int().nullable(),
    largest: z
      .object({ id: z.string(), description: z.string(), at: z.string(), amountMinor: money })
      .nullable(),
  }),
  categories: z.array(
    z.object({
      category: z.string(),
      amountMinor: money,
      count: z.number().int(),
      previousCount: z.number().int().default(0),
      previousMinor: money,
      deltaMinor: money,
    }),
  ),
  merchants: z.array(
    z.object({
      merchant: z.string(),
      amountMinor: money,
      count: z.number().int(),
      previousCount: z.number().int().default(0),
      previousMinor: money,
      deltaMinor: money,
    }),
  ),
  merchantCount: z.number().int(),
  daily: z.array(
    z.object({
      date: z.string(),
      expenseMinor: money,
      incomeMinor: money,
      count: z.number().int(),
      cumulativeMinor: money,
    }),
  ),
  weekdays: z.array(
    z.object({
      day: z.number().int(),
      days: z.number().int(),
      amountMinor: money,
      averageMinor: money,
    }),
  ),
  quality: z.object({
    unclassifiedCount: z.number().int(),
    unknownCurrencyCount: z.number().int(),
    pendingCount: z.number().int(),
    pendingMinor: money,
    possibleDuplicateCount: z.number().int(),
    resolvedDuplicateCount: z.number().int().default(0),
    invalidDirectionCount: z.number().int(),
    amountChangedCount: z.number().int(),
  }),
  report: financeReportSchema,
  reportScope: z.literal('all-accounts'),
  coverage: z.object({
    bankRetentionDays: z.number().int(),
    oldestTransactionAt: z.string().nullable(),
    beyondBankRetention: z.boolean(),
    previousBeforeFirstRecord: z.boolean().default(false),
  }),
});
export const analyticsOperationsSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  items: z.array(financeTxSchema),
  nextCursor: z.string().nullable(),
});
export type FinanceAnalytics = z.infer<typeof financeAnalyticsSchema>;
export const financeMerchantsSchema = z.object({
  ok: z.literal(true),
  items: financeAnalyticsSchema.shape.merchants,
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});
