import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { tg, inTelegram } from '../telegram.ts';
import { SessionExpiredError } from './client.ts';
import type { LeisureItem } from './leisure.ts';

const link = z.string().nullable();
const author = z.object({ name: z.string(), url: link });
export const placeSchema = z.object({
  name: z.string(),
  address: link,
  maps_uri: link,
  site: link,
  phone: link,
  rating: z.number().nullable(),
  userRatingCount: z.number().nullable(),
  price_range: z.unknown(),
  priceLevel: link,
  hours: z.array(z.string()),
  businessStatus: link,
  movedPlaceId: link,
  amenities: z.record(z.string(), z.boolean()),
  accessibility: z.record(z.string(), z.boolean()),
  payment: z.record(z.string(), z.boolean()),
  parking: z.record(z.string(), z.boolean()),
  photos: z.array(z.object({ name: z.string(), authors: z.array(author) })),
  fetched_at: z.string(),
  extended: z.boolean(),
  primaryType: z.string().optional(),
  types: z.array(z.string()).optional(),
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
});
const enrichmentSchema = z.object({
  itemId: z.string(),
  place: placeSchema.optional(),
  summary: z.string().optional(),
  film: z
    .object({
      originalTitle: z.string(),
      year: z.number().nullable(),
      countries: z.string(),
      language: z.string(),
      subtitles: z.string(),
      imdbRating: z.number().nullable(),
      imdbVotes: z.number().nullable(),
      imdbId: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type LeisureEnrichment = z.infer<typeof enrichmentSchema>;
export type LeisureLivePlace = z.infer<typeof placeSchema>;

async function read(op: string, payload: Record<string, unknown>, signal: AbortSignal) {
  const response = await fetch('/api/leisure', {
    method: 'POST',
    cache: 'no-store',
    signal,
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData ?? '',
      'X-Leisure-Format': '5',
    },
    body: JSON.stringify({ op, payload }),
  });
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Не вдалося отримати актуальні дані.',
    );
  }
  return response;
}
/** Active-view state only. Nothing goes to localStorage, IndexedDB or an inactive query cache. */
export function useLeisureEnrichment(item: LeisureItem, enabled = true, extended = false) {
  return useQuery({
    queryKey: ['leisure-live', item.id, extended],
    enabled: enabled && inTelegram() && (!!item.placeId || item.source === 'Планета кіно'),
    queryFn: async ({ signal }) => {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, extended ? 0 : 180);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return enrichmentSchema.parse(
        (await (await read('enrich', { itemId: item.id, extended }, signal)).json()).enrichment,
      );
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
export async function fetchLeisureImage(
  itemId: string,
  index: number,
  photo: string | undefined,
  signal: AbortSignal,
) {
  const response = await read('image', { itemId, index, ...(photo ? { photo } : {}) }, signal);
  return response.blob();
}
/** Share only while the photo is on screen (for example a card and its open details).
 * The last observer leaving cancels the request and immediately collects its Blob. */
export function useLeisureImage(
  item: LeisureItem,
  index: number,
  photo: string | undefined,
  visible: boolean,
) {
  const source = photo ?? item.media?.[index]?.url ?? '';
  return useQuery({
    queryKey: ['leisure-image', item.id, index, source],
    enabled: visible && inTelegram() && !!source,
    queryFn: ({ signal }) => fetchLeisureImage(item.id, index, photo, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
export { inTelegram as leisureLiveAvailable } from '../telegram.ts';
export { read as readLeisureLive };
