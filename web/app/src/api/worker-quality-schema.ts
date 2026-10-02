import { z } from 'zod';

/** Лише безпечні агрегати з приватного /api/assistant-status. */
export const workerQualityResponseSchema = z.object({
  dashboard: z.object({
    worker_quality: z.array(
      z.object({
        worker: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
        results: z.number().int().nonnegative(),
        sample_size: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        success_rate_pct: z.number().min(0).max(100).nullable(),
        avg_latency_ms: z.number().nonnegative().nullable(),
        max_latency_ms: z.number().nonnegative().nullable(),
        feedback: z.object({
          good: z.number().int().nonnegative(),
          bad: z.number().int().nonnegative(),
        }),
      }),
    ),
  }),
});

export type WorkerQuality = z.infer<
  typeof workerQualityResponseSchema
>['dashboard']['worker_quality'][number];
