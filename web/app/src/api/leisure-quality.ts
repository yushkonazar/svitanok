import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { placeSchema, readLeisureLive, leisureLiveAvailable } from './leisure-enrichment.ts';

const qualitySchema = z.object({
  checkedAt: z.string(),
  entries: z.array(z.object({ itemId: z.string(), place: placeSchema })),
  catalogTotal: z.number(),
  partial: z.boolean(),
  scope: z.literal('verified-catalogue-pool'),
});
export type LeisureFoodQuality = z.infer<typeof qualitySchema>;
export async function fetchLeisureFoodQuality(
  payload: Record<string, unknown>,
  signal: AbortSignal,
) {
  return qualitySchema.parse(
    (await (await readLeisureLive('food-quality', payload, signal)).json()).quality,
  );
}
export function useLeisureFoodQuality(parking: boolean) {
  return useQuery({
    queryKey: ['leisure-food-quality', parking],
    enabled: leisureLiveAvailable(),
    queryFn: ({ signal }) =>
      fetchLeisureFoodQuality({ parking }, AbortSignal.any([signal, AbortSignal.timeout(25000)])),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
