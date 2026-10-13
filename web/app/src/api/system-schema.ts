import { z } from 'zod';
import { workerQualityResponseSchema } from './worker-quality-schema.ts';
const section = <T extends z.ZodType>(schema: T) =>
  z.object({ available: z.boolean(), data: schema.nullable() });
const count = z.number().int().nonnegative();
export const systemSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  period: z.string(),
  mode: z.string(),
  runs: section(
    z.object({
      summary: z.object({ total: count, active: count, failed: count, completed: count }),
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
  billing: z.object({ connected: z.boolean(), balance: z.number().nullable() }),
});
export type SystemSnapshot = z.infer<typeof systemSchema>;
