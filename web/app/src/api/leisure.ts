import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { inTelegram, tg } from '../telegram.ts';
import { SessionExpiredError } from './client.ts';
import { recordRequestDiagnostic, type RequestDiagnostic } from './request-diagnostics.ts';
import { DEFAULT_LEISURE_SELECTION } from '../../../core/leisure/selection.mjs';

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
const mediaSchema = z.object({
  url: z.string(),
  kind: z.enum(['photo', 'poster', 'cover']),
  credit: z.string(),
  alt: z.string().optional(),
});
const filmSchema = z.object({
  originalTitle: z.string(),
  year: z.number().nullable(),
  countries: z.string(),
  language: z.string(),
  subtitles: z.string(),
  imdbRating: z.number().nullable(),
  imdbVotes: z.number().nullable(),
  imdbId: z.string().nullable(),
});
export const leisureItemSchema = z.object({
  id: z.string(),
  venueId: z.string().nullable(),
  placeId: z.string().nullable(),
  category: z.enum([
    'exhibition',
    'festival',
    'concert',
    'show',
    'cinema',
    'food',
    'trip',
    'place',
    'meetup',
    'podcast',
    'event',
  ]),
  title: z.string(),
  eventFormat: z.string().optional(),
  classificationEvidence: z.string().optional(),
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
  identityKey: z.string().optional(),
  firstDiscoveredAt: z.string().optional(),
  catalogChangedAt: z.string().nullable().optional(),
  catalogChanges: z.array(z.string()).optional(),
  medium: z.enum(['online', 'physical']).optional(),
  publishedAt: z.string().nullable().optional(),
  media: z.array(mediaSchema).optional(),
  schedule: z
    .object({
      kind: z.enum(['once', 'recurring', 'visit', 'on-request', 'unverified']),
      precision: z.enum(['exact', 'date', 'inferred', 'conflicting']),
      timeMode: z.enum(['window', 'fixed']).optional(),
      weekdays: z.array(z.number()),
      startTime: z.string().nullable(),
      endTime: z.string().nullable(),
      validFrom: z.string().nullable(),
      validThrough: z.string().nullable(),
      excludedDates: z.array(z.string()),
      occurrences: z.array(z.object({ startAt: z.string(), endAt: z.string().nullable() })),
      confirmationRequired: z.boolean(),
      minParticipants: z.number().nullable(),
    })
    .nullable()
    .optional(),
  evidence: z
    .array(
      z.object({
        field: z.string(),
        status: z.enum(['published', 'inferred', 'conflicting', 'unknown']),
        note: z.string(),
      }),
    )
    .optional(),
  qualityWarnings: z.array(z.string()).optional(),
  priceOffers: z
    .array(
      z.object({
        min: z.number(),
        max: z.number().nullable(),
        currency: z.string(),
        eligibility: z.string(),
        note: z.string(),
      }),
    )
    .optional(),
  film: filmSchema.nullable().optional(),
  podcast: z
    .object({
      series: z.string(),
      publisher: z.string(),
      language: z.string(),
      explicit: z.boolean().nullable(),
    })
    .nullable()
    .optional(),
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
  transport: z.enum(['walk', 'car', 'transit']).optional(),
  alerts: z.array(z.string()).optional(),
});
const visitSchema = z.object({
  id: z.string(),
  kind: z.literal('visit'),
  revision: z.number(),
  itemId: z.string(),
  venueId: z.string().nullable(),
  category: z.string(),
  eventFormat: z.string().nullable().optional(),
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
  interestLevel: z.enum(['priority', 'interested']).nullable().optional(),
  reasonCodes: z.array(z.string()).optional(),
  revisit: z.boolean().optional(),
  snoozeUntil: z.string().nullable().optional(),
  identityKey: z.string().optional(),
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
const draftSchema = z.object({
  id: z.string(),
  kind: z.literal('draft'),
  revision: z.number(),
  title: z.string(),
  stops: z.array(
    z.object({
      itemId: z.string(),
      sessionId: z.string().nullable().optional(),
      startAt: z.string(),
      endAt: z.string(),
      tickets: z.boolean(),
      reservation: z.boolean(),
      title: z.string().optional(),
      address: z.string().nullable().optional(),
      sourceUrl: z.string().nullable().optional(),
      catalogCheckedAt: z.string().optional(),
    }),
  ),
  transport: z.enum(['walk', 'car', 'transit']).optional(),
  estimatedBudgetMinor: z.number().nullable().optional(),
  discarded: z.boolean().optional(),
  alerts: z.array(z.string()).optional(),
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
    telegram: z.boolean(),
    planAlerts: z.boolean().default(true),
    selection: z
      .object({
        minFoodRating: z.number(),
        parking: z.enum(['any', 'preferred', 'required']),
        weeklyLimit: z.number(),
        formatFrequency: z.record(z.string(), z.enum(['often', 'sometimes', 'rare', 'manual'])),
        followedPodcastSeries: z.array(z.string()),
        categoryOverrides: z.record(
          z.string(),
          z.object({ category: z.string(), eventFormat: z.string() }),
        ),
      })
      .default(DEFAULT_LEISURE_SELECTION),
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
      draftSchema,
    ]),
  ),
  saved: z.array(z.string()),
  discoveryDecisions: z
    .array(
      z.object({
        identityKey: z.string(),
        itemId: z.string().optional(),
        verdict: z.string(),
        snoozeUntil: z.string().nullable(),
        at: z.string().optional(),
      }),
    )
    .optional(),
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
      highlightIds: z.array(z.string()).optional(),
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
          errorCode: z.string().nullable().optional(),
          coverage: z
            .object({
              withMedia: z.number(),
              withPrice: z.number(),
              withTime: z.number(),
              needsCheck: z.number(),
            })
            .optional(),
          diagnostics: z
            .object({
              attempted: z.number(),
              parsed: z.number(),
              accepted: z.number(),
              upcoming: z.number(),
              past: z.number(),
              invalid: z.number(),
              unparsed: z.number(),
              pageFailures: z.number(),
            })
            .optional(),
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
  sourceWarnings: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  revision: z.number().optional(),
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
export interface LeisurePlanSeed {
  title: string;
  sourceDraftId?: string;
  alerts?: string[];
  stops: Array<{
    itemId: string;
    sessionId?: string | null;
    startAt: string;
    endAt: string;
    tickets?: boolean;
    reservation?: boolean;
    title?: string;
    address?: string | null;
    catalogCheckedAt?: string;
  }>;
  transport?: 'walk' | 'car' | 'transit';
  estimatedBudgetMinor?: number | null;
}
const suggestionSchema = z.object({
  id: z.string(),
  date: z.string(),
  title: z.string(),
  stops: z.array(stopSchema),
  legs: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      minutes: z.number(),
      distanceM: z.number().nullable().optional(),
      verified: z.boolean(),
      boundary: z.enum(['outbound', 'return']).optional(),
    }),
  ),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  weather: z.array(z.string()).optional(),
  knownCostMinor: z.number(),
  costRange: z.object({ min: z.number(), max: z.number().nullable() }).optional(),
  unknownPrices: z.number(),
  transport: z.enum(['walk', 'car', 'transit']),
  confidence: z.enum(['needs-check', 'checked']),
  score: z.number(),
  anchorId: z.string(),
  alternatives: z.array(z.object({ id: z.string(), title: z.string(), priority: z.boolean() })),
});
export const leisureSuggestionsSchema = z.object({
  generatedAt: z.string(),
  recommendedDate: z.string().nullable(),
  recommendedReason: z.string().nullable().optional(),
  days: z.array(
    z.object({ date: z.string(), plans: z.array(suggestionSchema), notes: z.array(z.string()) }),
  ),
  sources: z.array(z.object({ name: z.string(), status: z.string(), checkedAt: z.string() })),
  note: z.string(),
});
export type LeisureSuggestion = z.infer<typeof suggestionSchema>;
export type LeisureSuggestions = z.infer<typeof leisureSuggestionsSchema>;
export async function fetchLeisureSuggestions(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LeisureSuggestions> {
  if (!inTelegram()) {
    const [{ readLeisureDemo }, { buildLeisureSuggestions }] = await Promise.all([
      import('./leisure-demo.ts'),
      import('../../../core/leisure/planning.mjs'),
    ]);
    return leisureSuggestionsSchema.parse(
      buildLeisureSuggestions(readLeisureDemo(), payload, Date.now(), { calendarAvailable: false }),
    );
  }
  const response = await fetch('/api/leisure', {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'suggest', payload }),
    signal: signal ?? AbortSignal.timeout(60000),
  });
  session(response);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? 'Не вдалося підібрати вихід. Спробуй ще раз.');
  const parsed = leisureSuggestionsSchema.safeParse(body?.suggestions);
  if (!parsed.success) throw new Error('Формат підбору змінився. Онови застосунок.');
  return parsed.data;
}
const headers = (): Record<string, string> =>
  inTelegram() && tg ? { 'X-Telegram-Init-Data': tg.initData, 'X-Leisure-Format': '5' } : {};
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
export async function verifyLeisureCommand(command: LeisureCommand) {
  const r = await fetch(`/api/leisure?commandId=${encodeURIComponent(command.commandId)}`, {
    headers: headers(),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  session(r);
  if (!r.ok) return null;
  const body = await r.json();
  const verified = body?.verification;
  if (!verified?.found) return null;
  const expected = JSON.stringify({
    op: command.op,
    id: command.id ?? null,
    payload: command.payload,
  });
  if (verified.fingerprint !== expected)
    throw new LeisureCommandRejectedError('Ідентифікатор належить іншій дії. Онови дозвілля.');
  const receipt = receiptSchema.safeParse(verified.receipt);
  return receipt.success ? { receipt: receipt.data, workspace: null } : null;
}
export async function changeLeisure(
  command: LeisureCommand,
  verifyFirst = false,
): Promise<{ receipt: LeisureReceipt; workspace: LeisureWorkspace | null }> {
  if (!inTelegram()) {
    const { changeLeisureDemo } = await import('./leisure-demo.ts');
    return changeLeisureDemo(command);
  }
  if (verifyFirst) {
    try {
      const applied = await verifyLeisureCommand(command);
      if (applied) return applied;
    } catch (error) {
      if (error instanceof SessionExpiredError || error instanceof LeisureCommandRejectedError)
        throw error;
    }
  }
  const serialized = JSON.stringify(command);
  let diagnostic: RequestDiagnostic | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    let status: number | null = null,
      requestId = command.commandId,
      code = 'network-failure',
      phase = 'send';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/leisure', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: serialized,
        signal: controller.signal,
      });
      status = response.status;
      if (status === 401 || status === 403) code = 'session-expired';
      else if (status >= 400 && status < 500) code = 'command-rejected';
      requestId = response.headers.get('X-Request-Id') ?? requestId;
      session(response);
      const body = await response.json().catch(() => null);
      if (body?.diagnostic) {
        if (/^[a-z-]{1,50}$/.test(body.diagnostic.code)) code = body.diagnostic.code;
        if (/^[a-z-]{1,30}$/.test(body.diagnostic.phase)) phase = body.diagnostic.phase;
      }
      if (response.status >= 500) {
        if (code === 'network-failure') code = 'server-failure';
        throw new Error(code);
      }
      if (!response.ok)
        throw new LeisureCommandRejectedError(
          typeof body?.error === 'string' ? body.error : 'Не вдалося підтвердити зміну.',
        );
      const receipt = receiptSchema.safeParse(body?.receipt);
      if (!body?.ok || !receipt.success) {
        code = 'invalid-response';
        phase = 'decode';
        throw new Error(code);
      }
      const workspace = body.workspace ? leisureWorkspaceSchema.safeParse(body.workspace) : null;
      return { receipt: receipt.data, workspace: workspace?.success ? workspace.data : null };
    } catch (error) {
      diagnostic = recordRequestDiagnostic({
        at: new Date().toISOString(),
        area: 'leisure',
        operation: command.op,
        requestId,
        phase,
        status,
        code: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : code,
        layer: status == null ? 'network' : code === 'invalid-response' ? 'client' : 'server',
        durationMs: Date.now() - started,
        attempt: attempt + 1,
      });
      if (error instanceof SessionExpiredError || error instanceof LeisureCommandRejectedError)
        throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new LeisureSaveUncertainError(diagnostic);
}
export class LeisureSaveUncertainError extends Error {
  readonly inlineRecovery = true;
  diagnostic?: RequestDiagnostic;
  constructor(diagnostic?: RequestDiagnostic) {
    super(
      'Не отримано підтвердження збереження. Натисни «Перевірити збереження»: повторимо ту саму дію без нового запису.',
    );
    this.diagnostic = diagnostic;
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
    mutationFn: (command: LeisureCommand & { verifyFirst?: boolean }) => {
      const { verifyFirst, ...original } = command;
      return changeLeisure(original, verifyFirst);
    },
    onSuccess: async (result, command) => {
      await cache.cancelQueries({ queryKey: LEISURE_QUERY });
      if (result.workspace) cache.setQueryData(LEISURE_QUERY, result.workspace);
      else {
        if (command.op === 'reaction' && command.id)
          cache.setQueryData<LeisureWorkspace>(LEISURE_QUERY, (old) => {
            if (!old) return old;
            const records = old.records.filter(
              (r) => !(r.kind === 'reaction' && r.itemId === command.id),
            );
            records.push({
              id: `reaction-${command.id}`,
              kind: 'reaction',
              itemId: command.id!,
              venueId: old.items.find((i) => i.id === command.id)?.venueId ?? null,
              verdict: String(command.payload.verdict),
              interestLevel:
                command.payload.verdict === 'interested'
                  ? command.payload.interestLevel === 'priority'
                    ? 'priority'
                    : 'interested'
                  : null,
              reasonCodes: Array.isArray(command.payload.reasonCodes)
                ? command.payload.reasonCodes.map(String)
                : [],
              revisit: command.payload.revisit === true,
              snoozeUntil:
                typeof command.payload.snoozeUntil === 'string'
                  ? command.payload.snoozeUntil
                  : null,
              reasonCode:
                typeof command.payload.reasonCode === 'string' ? command.payload.reasonCode : null,
              reason: String(command.payload.reason ?? ''),
              at: new Date().toISOString(),
              revision: result.receipt.revision ?? Number(command.payload.revision ?? 0) + 1,
            });
            return { ...old, records };
          });
        void cache.invalidateQueries({ queryKey: LEISURE_QUERY });
      }
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
  place: 'Місця й музеї',
  meetup: 'Зустрічі й майстер-класи',
  podcast: 'Подкасти',
  event: 'Інші події',
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
  if (min == null || item.price.basis === 'unknown' || item.price.currency !== 'UAH') return null;
  return (Math.round(min * 100) * (item.price.basis === 'person' ? 2 : 1)) / 100;
}
export function money(value: number) {
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value)} ₴`;
}
