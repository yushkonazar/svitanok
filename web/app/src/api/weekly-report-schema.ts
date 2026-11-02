import { z } from 'zod';

const number = z.number().finite();
const status = z.enum(['ready', 'partial', 'failed']);
const period = z.object({
  from: z.string(),
  to: z.string(),
  asOf: z.string(),
  dateFrom: z.string(),
  dateTo: z.string(),
});
const metric = z.object({
  n: number.optional(),
  numericN: number.optional(),
  average: number.nullish(),
});
const personalPeriod = z.object({
  period: period.nullish(),
  legacy: z.record(z.string(), metric).nullish(),
  observationsV2: z.record(z.string(), metric).nullish(),
  observationsV3: z.record(z.string(), metric).nullish(),
  coverage: z
    .record(
      z.string(),
      z.object({ recordedDays: number.optional(), confirmedSlots: number.optional() }),
    )
    .optional(),
});
const moneyRow = z.object({
  category: z.string().optional(),
  amountMinor: number.optional(),
  count: number.optional(),
});
const payment = z.object({
  name: z.string().optional(),
  date: z.string().optional(),
  amountMinor: number.nullish(),
  currency: z.string().optional(),
});
const payments = z.object({
  count: number.optional(),
  knownTotalMinor: number.optional(),
  complete: z.boolean().optional(),
  payments: z.array(payment).optional(),
});
const usage = z.object({
  records: number.optional(),
  knownCostRecords: number.optional(),
  unpricedRecords: number.optional(),
  estimatedUsd: number.nullish(),
});
const details = z.object({
  plan: z
    .object({
      summary: z
        .object({
          acceptedCommitments: number.optional(),
          distinctResults: number.optional(),
          completedDistinctResults: number.optional(),
          lifecycle: z.record(z.string(), number).nullish(),
        })
        .optional(),
      tasks: z
        .array(
          z.object({
            title: z.string().optional(),
            lifecycle: z.string().optional(),
            dueAt: z.string().optional(),
          }),
        )
        .optional(),
    })
    .nullish(),
  personalPeriods: z
    .object({
      current: personalPeriod.nullish(),
      previousWeeks: z.array(personalPeriod.nullable()).optional(),
    })
    .nullish(),
  finance: z
    .object({
      summary: z.object({ expenseMinor: number.optional(), count: number.optional() }).nullish(),
      sourceTotals: z
        .record(
          z.string(),
          z.object({ expenseMinor: number.optional(), count: number.optional() }).nullable(),
        )
        .optional(),
      categoryBreakdown: z
        .object({
          top: z.array(moneyRow).optional(),
          rest: moneyRow.nullish(),
          otherCategory: moneyRow.nullish(),
        })
        .nullish(),
      comparison: z
        .object({
          complete: z.boolean().optional(),
          averageExpenseMinor: number.nullish(),
          previousWeek: z
            .object({ complete: z.boolean().optional(), expenseMinor: number.nullish() })
            .nullish(),
        })
        .nullish(),
      review: z
        .object({
          outflows: z
            .object({
              confirmedExpenseMinor: number.optional(),
              pendingExpenseMinor: number.optional(),
            })
            .nullish(),
        })
        .nullish(),
      context: z
        .object({
          asOf: z.string().optional(),
          snapshotPolicy: z.string().optional(),
          balances: z
            .object({ complete: z.boolean().optional(), ownedMinor: number.nullish() })
            .nullish(),
          reserves: z
            .object({
              complete: z.boolean().optional(),
              availableAfterReservesMinor: number.nullish(),
            })
            .nullish(),
          upcoming: payments.nullish(),
          overdue: payments.nullish(),
        })
        .nullish(),
    })
    .nullish(),
  system: z
    .object({
      runs: z.object({ total: number.optional(), failed: number.optional() }).nullish(),
      toolCalls: z.object({ total: number.optional(), failed: number.optional() }).nullish(),
      costs: z.object({ month: usage.nullish(), selected: usage.nullish() }).nullish(),
    })
    .nullish(),
});
export const weeklyReportsSchema = z.object({
  history: z.array(z.object({ week: z.string(), to: z.string(), status, createdAt: z.string() })),
  report: z
    .object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      status,
      asOf: z.string().nullable(),
      createdAt: z.string(),
      text: z.string(),
      missing: z.array(z.string()),
      details: details.nullable(),
      analysis: z
        .object({
          sections: z.array(
            z.object({
              kind: z.enum(['personal', 'plan', 'finance']),
              title: z.string(),
              paragraphs: z.array(z.string()),
              evidence: z.array(z.object({ label: z.string(), value: z.string() })),
            }),
          ),
          actions: z.array(z.string()),
        })
        .nullish(),
    })
    .nullable(),
});
export type WeeklyReports = z.infer<typeof weeklyReportsSchema>;
