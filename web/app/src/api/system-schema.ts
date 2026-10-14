import { z } from 'zod';
import { workerQualityResponseSchema } from './worker-quality-schema.ts';
const section = <T extends z.ZodType>(schema: T) =>
  z.object({
    available: z.boolean(),
    data: schema.nullable(),
    reason: z.string().optional(),
    cached: z.boolean().optional(),
    checkedAt: z.string().optional(),
  });
const count = z.number().int().nonnegative();
const usageGroup = z.object({
  feature: z.string().optional(),
  provider: z.string().optional(),
  sku: z.string().optional(),
  records: count,
  knownCosts: count,
  costUsd: z.number().nullable(),
  estimatedUsd: z.number().nullable(),
  equivalentUsd: z.number().nullable(),
  equivalents: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  cachedTokens: count.nullable(),
  cacheWriteTokens: count.nullable(),
  knownInput: count,
  knownOutput: count,
  failed: count,
});
const tokenUsage = z.object({
  input_tokens: count.nullable(),
  output_tokens: count.nullable(),
  total_tokens: count.nullable(),
  cached_input_tokens: count.nullable(),
  cache_write_tokens: count.nullable(),
  reasoning_tokens: count.nullable(),
});
const budgets = z.object({
  overallUsd: z.number().positive().nullable(),
  features: z.record(z.string(), z.number().positive()),
});
export const systemPreferencesSchema = z.object({
  revision: count,
  budgets,
  enforcement: z.literal(false),
  notifications: z.literal(false),
});
export const systemSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  period: z.string(),
  mode: z.string(),
  selection: z
    .object({
      range: z.string(),
      from: z.string(),
      to: z.string(),
      since: z.string(),
      until: z.string(),
      telemetryDays: count,
    })
    .optional(),
  usage: section(
    usageGroup.extend({
      items: z.array(usageGroup),
      features: z.array(usageGroup),
      providers: z.array(usageGroup),
      daily: z.array(usageGroup.extend({ day: z.string() })),
      legacyTruncated: z.boolean(),
      trackingSince: z.string().nullable(),
      historicalCoverage: z.string(),
      retentionDays: count,
    }),
  ).optional(),
  preferences: section(systemPreferencesSchema).optional(),
  services: section(
    z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        href: z.string(),
        available: z.boolean(),
        state: z.string(),
        detail: z.string(),
        checkedAt: z.string().nullable(),
        metrics: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
        sources: z
          .array(
            z.object({
              label: z.string(),
              state: z.string(),
              checkedAt: z.string().nullable(),
              count: count,
            }),
          )
          .optional(),
      }),
    ),
  ).optional(),
  runs: section(
    z.object({
      summary: z.object({ total: count, active: count, failed: count, completed: count }),
      nextCursor: z.string().nullable().optional(),
      worker_quality: workerQualityResponseSchema.shape.dashboard.shape.worker_quality,
      recent: z.array(
        z.object({
          id: z.string().nullable(),
          profile: z.string().nullable(),
          trigger: z.string().nullable(),
          terminal: z.string(),
          started_at: z.string().nullable(),
          duration_ms: z.number().nullable(),
          model: z.string().nullable(),
          retries: count,
          error: z.string().nullable(),
          tools: z.object({ calls: count }),
          queue_wait_ms: z.number().nullable().optional(),
          error_class: z.string().nullable().optional(),
          steps_truncated: z.boolean().optional(),
          steps: z
            .array(
              z.object({
                kind: z.string(),
                name: z.string(),
                ms: z.number().nullable(),
                ok: z.boolean().nullable(),
              }),
            )
            .optional(),
          models: z
            .array(
              z.object({
                name: z.string(),
                usage: tokenUsage,
                usage_complete: z.boolean().nullable(),
                model_responses: count.nullable(),
                api_attempts: count.nullable(),
                estimated_cost_usd: z.number().nullable(),
                duration_ms: z.number().nullable(),
                ok: z.boolean().nullable(),
              }),
            )
            .optional(),
        }),
      ),
    }),
  ),
  models: section(
    z.object({
      since: z.string(),
      truncated: z.boolean(),
      items: z.array(
        z.object({
          model: z.string(),
          calls: count,
          knownCostCalls: count,
          knownUsageCalls: count,
          costUsd: z.number().nonnegative().nullable(),
          inputTokens: count.nullable(),
          outputTokens: count.nullable(),
          shadow: z.boolean(),
        }),
      ),
    }),
  ),
  quotas: section(
    z.array(
      z.object({
        key: z.string(),
        value: z.number(),
        limit_value: z.number(),
        updated_at: z.string(),
      }),
    ),
  ),
  scheduler: section(
    z.object({ lastTick: z.unknown().nullable(), scheduled: count, watchdogRescues: count }),
  ),
  registry: section(z.object({ active: count })),
  delivery: section(
    z.object({
      reminders: z.object({ due: count, breached: count, status: z.string() }),
      outbox: z.object({ pending: count, failed: count, stuck: count, status: z.string() }),
      briefing: z.object({ status: z.string(), last_sent_date: z.string().nullable() }),
    }),
  ),
  brain: section(
    z.object({ state: z.string(), checkedAtMs: z.number().nullable(), modelState: z.string() }),
  ).optional(),
  deployment: z.string().nullable().optional(),
  billing: z.object({
    connected: z.boolean(),
    balance: z.number().nullable(),
    items: z
      .array(
        z.object({
          provider: z.string(),
          title: z.string(),
          supported: z.boolean(),
          configured: z.boolean(),
          url: z.string(),
          steps: z.array(z.string()),
          errorClass: z.string().nullable(),
          attemptedAt: z.string().nullable(),
          retryAt: z.string().nullable().optional(),
          refreshing: z.boolean().optional(),
          normalizationApplied: z.boolean().optional(),
          snapshot: z
            .object({
              costUsd: z.number(),
              balanceUsd: z.number().nullable(),
              currency: z.string(),
              timeZone: z.string(),
              from: z.string(),
              to: z.string(),
              basis: z.string(),
              provisional: z.boolean(),
              collectedAt: z.string(),
            })
            .nullable(),
        }),
      )
      .optional(),
  }),
});
export type SystemSnapshot = z.infer<typeof systemSchema>;
