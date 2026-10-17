import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { inTelegram, tg } from '../telegram.ts';
import { SessionExpiredError } from './client.ts';

const sessionSchema = z.object({
  id: z.string(),
  cinema: z.string(),
  cinemaSlug: z.string().default(''),
  address: z.string().default(''),
  startAt: z.string(),
  endAt: z.string().nullable(),
  format: z.string(),
  language: z.string(),
  price: z.number().nullable(),
  url: z.string().nullable(),
});
export const leisureItemSchema = z.object({
  id: z.string(),
  venueId: z.string().nullable(),
  placeId: z.string().nullable(),
  category: z.enum(['exhibition', 'festival', 'concert', 'show', 'cinema', 'food', 'trip']),
  title: z.string(),
  summary: z.string(),
  venue: z.string().nullable(),
  address: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  sourceUrl: z.string(),
  source: z.string(),
  checkedAt: z.string(),
  price: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    currency: z.string(),
    basis: z.enum(['person', 'pair', 'unknown']),
    note: z.string(),
  }),
  status: z.enum(['available', 'sold-out', 'cancelled', 'postponed', 'schedule-pending']),
  registration: z.boolean(),
  hours: z.string(),
  studentNote: z.string(),
  sessions: z.array(sessionSchema),
  genre: z.string().default(''),
  durationMinutes: z.number().nullable().default(null),
  age: z.string().default(''),
  placeType: z.string().default(''),
  bookingUrl: z.string().nullable().default(null),
  siteUrl: z.string().nullable().default(null),
  placeDetails: z.record(z.string(), z.unknown()).optional(),
});
const stopSchema = z.object({
  itemId: z.string(),
  sessionId: z.string().nullable().optional(),
  startAt: z.string(),
  endAt: z.string(),
  title: z.string(),
  address: z.string().nullable(),
  venueId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  tickets: z.boolean(),
  reservation: z.boolean(),
});
export const leisurePlanSchema = z.object({
  id: z.string(),
  kind: z.literal('plan'),
  revision: z.number(),
  title: z.string(),
  stops: z.array(stopSchema),
  startAt: z.string(),
  endAt: z.string(),
  status: z.enum(['planned', 'cancelled', 'went', 'not-went']),
  calendar: z.boolean(),
  calendarId: z.string().nullable(),
  calendarState: z.enum(['none', 'pending', 'delete-pending', 'error', 'synced', 'conflict']),
  reason: z.string().optional(),
  estimatedBudgetMinor: z.number().nullable().optional(),
});
const visitSchema = z.object({
  id: z.string(),
  kind: z.literal('visit'),
  revision: z.number(),
  itemId: z.string(),
  venueId: z.string().nullable(),
  category: z.string(),
  title: z.string(),
  visitedOn: z.string().nullable(),
  rating: z.enum(['liked', 'neutral', 'disliked']).nullable(),
  reason: z.string(),
  planId: z.string().nullable(),
  legacy: z.boolean().default(false),
});
const reactionSchema = z.object({
  id: z.string(),
  kind: z.literal('reaction'),
  revision: z.number(),
  itemId: z.string(),
  venueId: z.string().nullable(),
  verdict: z.string(),
  reasonCode: z.string().nullable().default(null),
  reason: z.string().default(''),
  at: z.string().nullable().default(null),
});
const familiaritySchema = z.object({
  id: z.string(),
  kind: z.literal('familiarity'),
  revision: z.number(),
  itemId: z.string(),
  venueId: z.string().nullable(),
  title: z.string(),
  mode: z.enum(['count', 'many', 'unknown', 'clear']),
  previousCount: z.number().nullable(),
  trackingSince: z.string(),
  cleared: z.boolean().default(false),
});
export const leisureWorkspaceSchema = z.object({
  preferenceProfile: z
    .object({
      signals: z.number(),
      interests: z.array(
        z.object({
          feature: z.string(),
          label: z.string(),
          score: z.number(),
          samples: z.number(),
        }),
      ),
    })
    .optional(),
  version: z.literal(1),
  generatedAt: z.string(),
  settings: z.object({
    enabled: z.boolean(),
    city: z.string(),
    transport: z.string(),
    updateHour: z.number(),
    categories: z.array(z.string()),
    cinemas: z.array(z.string()),
    students: z.number(),
    retention: z.string(),
    telegram: z.literal(false),
  }),
  items: z.array(leisureItemSchema),
  knownPlaces: z
    .record(
      z.string(),
      z.object({
        familiar: z.boolean(),
        frequent: z.boolean(),
        previousCount: z.number().nullable(),
        trackedCount: z.number(),
        legacyCount: z.number(),
        since: z.string().nullable(),
      }),
    )
    .default({}),
  records: z.array(
    z.discriminatedUnion('kind', [
      leisurePlanSchema,
      visitSchema,
      reactionSchema,
      familiaritySchema,
    ]),
  ),
  saved: z.array(z.string()),
  historyLimit: z.number(),
  historyTotal: z.number().default(0),
  editionHistory: z.array(z.record(z.string(), z.unknown())).optional(),
  refresh: z
    .object({
      active: z.boolean(),
      done: z.number(),
      total: z.number(),
      requestedAt: z.string(),
      completedAt: z.string().nullable(),
    })
    .nullable()
    .optional(),
  edition: z
    .object({
      week: z.string(),
      until: z.string(),
      ids: z.array(z.string()),
      futureIds: z.array(z.string()),
      createdAt: z.string(),
      reason: z.string(),
      stale: z.boolean(),
      sources: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          url: z.string(),
          status: z.string(),
          checkedAt: z.string(),
          count: z.number(),
        }),
      ),
      cinemaUpdatedAt: z.string().nullable(),
      rankings: z
        .array(
          z.object({
            id: z.string(),
            score: z.number(),
            reasons: z.array(z.string()),
            known: z.object({
              familiar: z.boolean(),
              frequent: z.boolean(),
              previousCount: z.number().nullable(),
              trackedCount: z.number(),
              legacyCount: z.number(),
              since: z.string().nullable(),
            }),
          }),
        )
        .default([]),
      profileSignals: z.number().default(0),
    })
    .nullable(),
});
const receiptSchema = z.object({
  message: z.string(),
  id: z.string().optional(),
  available: z.boolean().optional(),
  place: z.record(z.string(), z.unknown()).optional(),
  legs: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        available: z.boolean(),
        minutes: z.number().optional(),
        distanceM: z.number().optional(),
        gapMinutes: z.number().optional(),
        enoughTime: z.boolean().optional(),
      }),
    )
    .optional(),
  conflicts: z
    .array(
      z.object({
        id: z.string().nullable(),
        title: z.string().nullable(),
        startAt: z.string(),
        endAt: z.string(),
      }),
    )
    .optional(),
});
export type LeisureItem = z.infer<typeof leisureItemSchema>;
export type LeisurePlan = z.infer<typeof leisurePlanSchema>;
export type LeisureVisit = z.infer<typeof visitSchema>;
export type LeisureWorkspace = z.infer<typeof leisureWorkspaceSchema>;
export type LeisureReceipt = z.infer<typeof receiptSchema>;
export interface LeisureCommand {
  op: string;
  id?: string;
  payload: Record<string, unknown>;
  commandId: string;
}
export const LEISURE_QUERY = ['leisure'] as const;
const headers = (): Record<string, string> =>
  inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData, 'X-Leisure-Format': '2' } : {};
function session(response: Response) {
  if (response.status === 401 || response.status === 403)
    throw new SessionExpiredError(response.status);
}
export async function fetchLeisure(allHistory = false) {
  if (!inTelegram()) {
    const { readLeisureDemo } = await import('./leisure-demo.ts');
    return readLeisureDemo();
  }
  const response = await fetch(`/api/leisure${allHistory ? '?history=all' : ''}`, {
    headers: headers(),
    cache: 'no-store',
  });
  session(response);
  if (!response.ok) throw new Error('Не вдалося завантажити дозвілля. Спробуй ще раз.');
  const parsed = leisureWorkspaceSchema.safeParse((await response.json())?.workspace);
  if (!parsed.success) throw new Error('Формат дозвілля змінився. Онови застосунок.');
  return parsed.data;
}
export async function changeLeisure(command: LeisureCommand) {
  if (!inTelegram()) {
    const { changeLeisureDemo } = await import('./leisure-demo.ts');
    return changeLeisureDemo(command);
  }
  const serialized = JSON.stringify(command);
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/leisure', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: serialized,
        signal: controller.signal,
      });
      session(response);
      if (response.status >= 500) throw new LeisureSaveUncertainError();
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new LeisureCommandRejectedError(
          typeof body?.error === 'string' ? body.error : 'Не вдалося підтвердити зміну.',
        );
      const receipt = receiptSchema.safeParse(body?.receipt);
      if (!body?.ok || !receipt.success) throw new LeisureSaveUncertainError();
      const workspace = body.workspace ? leisureWorkspaceSchema.safeParse(body.workspace) : null;
      return { receipt: receipt.data, workspace: workspace?.success ? workspace.data : null };
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof LeisureCommandRejectedError)
        throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new LeisureSaveUncertainError();
}
export class LeisureSaveUncertainError extends Error {
  constructor() {
    super(
      'Не отримано підтвердження збереження. Натисни «Перевірити збереження»: повторимо ту саму дію без нового запису.',
    );
  }
}
export class LeisureCommandRejectedError extends Error {}
export function useLeisure() {
  return useQuery({
    queryKey: LEISURE_QUERY,
    queryFn: () => fetchLeisure(),
    staleTime: 60000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.refresh?.active ? 15000 : false),
  });
}
export function useLeisureChange() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: changeLeisure,
    onSuccess: async (result) => {
      if (result.workspace) cache.setQueryData(LEISURE_QUERY, result.workspace);
      else void cache.invalidateQueries({ queryKey: LEISURE_QUERY });
      void cache.invalidateQueries({ queryKey: ['saved'] });
      void cache.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export const categoryLabels: Record<LeisureItem['category'], string> = {
  exhibition: 'Виставки',
  festival: 'Фестивалі',
  concert: 'Концерти',
  show: 'Шоу й театр',
  cinema: 'Кіно',
  food: 'Заклади',
  trip: 'Поїздки',
};
export function leisureDate(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}
export function leisureTime(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(value));
}
export function toKyivInput(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Kyiv',
  }).formatToParts(new Date(value));
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${at('year')}-${at('month')}-${at('day')}T${at('hour')}:${at('minute')}`;
}
export function fromKyivInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Укажи дату й час.');
  const utc = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(utc)) throw new Error('Перевір дату й час.');
  const observed = Date.parse(`${toKyivInput(new Date(utc).toISOString())}:00Z`),
    result = new Date(utc - (observed - utc)).toISOString();
  if (toKyivInput(result) !== value)
    throw new Error('Цього місцевого часу не існує через переведення годинника.');
  return result;
}
export function pairPrice(item: LeisureItem) {
  const min = item.price.min;
  if (min == null || item.price.basis === 'unknown') return null;
  return (Math.round(min * 100) * (item.price.basis === 'person' ? 2 : 1)) / 100;
}
export function money(value: number) {
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value)} ₴`;
}
