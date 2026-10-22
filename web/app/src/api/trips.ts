import { z } from 'zod';
import { tg, inTelegram } from '../telegram.ts';
import { throwIfSessionExpired } from './client.ts';

const task = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  due_at: z.string().nullable().optional(),
  note: z.string().optional(),
  owner: z.string().optional(),
  group: z.string().optional(),
});
const booking = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.string(),
  source_url: z.string().nullable().optional(),
  reference: z.string().optional(),
  cancel_by: z.string().nullable().optional(),
  checkin_at: z.string().nullable().optional(),
});
const leg = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  start_zone: z.string(),
  end_zone: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  mode: z.string().nullable().optional(),
  transfer_minutes: z.number().optional(),
  source_url: z.string().nullable().optional(),
  booked: z.boolean().optional(),
});
const option = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  provider: z.string().optional(),
  source_url: z.string(),
  checked_at: z.string(),
  location: z.string().optional(),
  dates: z.string().optional(),
  stale: z.boolean(),
  availability: z.string(),
  tradeoffs: z.string().optional(),
  missing: z.string().optional(),
  cancellation: z.string().optional(),
  schedule: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  duration_minutes: z.number().nullable().optional(),
  rating: z
    .object({ value: z.number(), scale: z.number(), count: z.number(), source: z.string() })
    .nullable()
    .optional(),
  photos: z.array(z.object({ url: z.string(), alt: z.string(), credit: z.string() })).optional(),
  service_links: z
    .array(z.object({ id: z.string(), label: z.string(), url: z.string(), prefilled: z.boolean() }))
    .optional(),
  price: z
    .object({
      amount: z.number(),
      currency: z.string(),
      unit: z.string(),
      quantity: z.number(),
      total_confirmed: z.boolean().optional(),
      includes: z.string().optional(),
      excludes: z.string().optional(),
    })
    .nullable(),
});
const research = z.object({
  revision: z.number().optional(),
  stale: z.boolean(),
  options: z.array(option),
  selections: z.record(z.string(), z.string()).optional(),
  selection_warnings: z.array(z.string()).optional(),
  summary: z.string().optional(),
});
const planningQuestion = z.object({
  field: z.string(),
  section: z.string(),
  question: z.string(),
  type: z.string(),
  optional: z.boolean().optional(),
  custom: z.boolean(),
  hint: z.string().optional(),
  choices: z.array(
    z.object({ value: z.union([z.string(), z.number(), z.boolean()]), label: z.string() }),
  ),
});
const planning = z.object({
  revision: z.number(),
  brief_revision: z.number(),
  remaining: z.number(),
  confirmed: z.boolean(),
  step: z.string(),
  question: planningQuestion.nullable(),
  fields: z.array(planningQuestion),
  stages: z.array(
    z.object({
      kind: z.string(),
      status: z.string(),
      summary: z.string(),
      started_at: z.string().nullable(),
      options: z.array(option),
      service_links: z
        .array(
          z.object({ id: z.string(), label: z.string(), url: z.string(), prefilled: z.boolean() }),
        )
        .optional(),
      resolved: z.boolean(),
      needs_review: z.boolean(),
      decision: z
        .object({
          mode: z.string(),
          options: z.array(option.omit({ stale: true })),
          note: z.string(),
        })
        .nullable(),
    }),
  ),
  providers: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
});
const workspace = z.object({
  revision: z.number(),
  itinerary_stale: z.boolean().optional(),
  legs: z.array(leg),
  warnings: z.array(z.string()),
  tasks: z.array(task),
  bookings: z.array(booking),
  party: z.array(z.object({ id: z.string(), label: z.string(), count: z.number() })),
  progress: z.object({ stage: z.string(), confirmed: z.boolean() }),
  preferences: z.record(z.string(), z.unknown()),
  places: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      note: z.string().optional(),
      url: z.string().nullable().optional(),
    }),
  ),
  reviews: z.array(
    z.object({ date: z.string(), note: z.string(), unfinished: z.string().optional() }),
  ),
  history: z.array(z.object({ at: z.string(), op: z.string(), revision: z.number() })),
  itinerary_versions: z.array(z.object({ revision: z.number(), at: z.string() })),
});
const ledger = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      minor: z.number(),
      currency: z.string(),
      category: z.string(),
      kind: z.string().optional(),
      note: z.string(),
      paid_by: z.string().optional(),
      refers_to: z.string().nullable().optional(),
    }),
  ),
  totals_minor_by_currency: z.record(z.string(), z.number()),
  pending_deposits_minor_by_currency: z.record(z.string(), z.number()).optional(),
  unallocated_minor_by_currency: z.record(z.string(), z.number()).optional(),
  suggested_settlement: z
    .array(z.object({ from: z.string(), to: z.string(), minor: z.number(), currency: z.string() }))
    .optional(),
});
export const travelSchema = z.object({
  ok: z.boolean(),
  capabilities: z.object({ weather: z.boolean() }).optional(),
  acknowledged: z.boolean().optional(),
  refreshRequired: z.boolean().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      date_from: z.string().nullable(),
      date_to: z.string().nullable(),
      status: z.string(),
    }),
  ),
  current: z
    .object({
      id: z.string(),
      kind: z.string(),
      status: z.string().optional(),
      revision: z.number().optional(),
      draft_id: z.string().optional(),
      brief_id: z.string().nullable().optional(),
      planning: planning.nullable().optional(),
      answers: z.record(z.string(), z.unknown()),
      phase: z.string().optional(),
      ready_for_research: z.boolean().optional(),
      ask: z
        .array(
          z.object({
            field: z.string(),
            question: z.string(),
            optional: z.boolean().optional(),
            options: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      workspace: workspace.optional(),
      ledger: ledger.optional(),
      research: research.nullable().optional(),
    })
    .nullable(),
  receipt: z.unknown().optional(),
});
export type TravelSnapshot = z.infer<typeof travelSchema>;
export type TravelCurrent = NonNullable<TravelSnapshot['current']>;
export type TravelOption = NonNullable<
  TravelCurrent['planning']
>['stages'][number]['options'][number];
const tripMapSchema = z.object({
  enabled: z.boolean(),
  external_url: z.string(),
  message: z.string().optional(),
  api_key: z.string().optional(),
  map_id: z.string().optional(),
  caption: z.string().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  markers: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        label: z.string().optional(),
        lat: z.number(),
        lon: z.number(),
        source_url: z.string().nullable().optional(),
      }),
    )
    .optional(),
  route: z
    .object({ polyline: z.string().optional(), duration_min: z.number(), distance_m: z.number() })
    .nullable()
    .optional(),
  missing: z.array(z.string()).optional(),
});
export type TripMapData = z.infer<typeof tripMapSchema>;
export async function fetchTripMap(
  id: string,
  kind: string,
  signal?: AbortSignal,
  focusId?: string,
): Promise<TripMapData> {
  if (!inTelegram())
    return {
      enabled: false,
      external_url: 'https://www.google.com/maps/search/?api=1&query=Prague',
      message: 'Мапа прикладу. Власні поїздки відкрий у Telegram.',
    };
  const query = new URLSearchParams({ id, kind, format: 'map' });
  if (focusId) query.set('focus', focusId);
  const response = await fetch(`/api/trips?${query}`, {
    headers: headers(),
    cache: 'no-store',
    signal,
  });
  throwIfSessionExpired(response);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Не вдалося відкрити мапу.');
  return tripMapSchema.parse(body);
}
export type TravelCommand = {
  op:
    | 'brief'
    | 'select'
    | 'start'
    | 'research'
    | 'planning'
    | 'workspace'
    | 'expense'
    | 'cancel'
    | 'delete'
    | 'reschedule'
    | 'weather-consent';
  id?: string;
  revision?: number;
  skip_field?: string;
  data?: Record<string, unknown>;
};
export class TravelChangeError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) {
    super(message);
    this.uncertain = uncertain;
  }
}
const headers = () => ({
  'content-type': 'application/json',
  ...(tg && inTelegram() ? { 'X-Telegram-Init-Data': tg.initData } : {}),
});
export async function fetchTrips(id?: string): Promise<TravelSnapshot> {
  if (!inTelegram()) return travelSchema.parse(demoSnapshot);
  const response = await fetch(`/api/trips${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
    headers: headers(),
    cache: 'no-store',
  });
  throwIfSessionExpired(response);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Не вдалося відкрити подорожі.');
  return travelSchema.parse(body);
}
export async function changeTrip(command: TravelCommand): Promise<TravelSnapshot | null> {
  if (!inTelegram())
    throw new TravelChangeError(
      'Це приклад. Відкрий Світанок у Telegram, щоб зберігати свої поїздки.',
    );
  const response = await fetch('/api/trips', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(command),
  }).catch(() => {
    throw new TravelChangeError(
      'Не отримав підтвердження зміни. Онови поїздку перед повтором.',
      true,
    );
  });
  throwIfSessionExpired(response);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.acknowledged !== true)
    throw new TravelChangeError(body?.error ?? 'Не вдалося підтвердити зміну. Онови дані.', true);
  if (body.refreshRequired) return null;
  const parsed = travelSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
export async function downloadTrip(id: string) {
  if (!inTelegram()) return;
  const response = await fetch(`/api/trips?id=${encodeURIComponent(id)}&format=md`, {
    headers: headers(),
    cache: 'no-store',
  });
  throwIfSessionExpired(response);
  if (!response.ok) throw new Error('Не вдалося зберегти офлайн-план.');
  const url = URL.createObjectURL(await response.blob()),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'travel-plan.md';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const demoSnapshot = {
  ok: true,
  items: [
    {
      id: 'demo-prague',
      kind: 'trip',
      title: 'Прага',
      date_from: '2026-11-12',
      date_to: '2026-11-16',
      status: 'active',
    },
  ],
  current: {
    id: 'demo-prague',
    kind: 'trip',
    status: 'active',
    answers: {
      to: 'Прага',
      from_city: 'Львів',
      date_from: '2026-11-12',
      date_to: '2026-11-16',
      mode: 'bus',
      transport_count: 2,
      destination_count: 4,
      lodging_count: 4,
      timezone: 'Europe/Prague',
      departure_timezone: 'Europe/Kyiv',
      purpose: 'дозвілля',
      budget_scope: 'whole_group',
    },
    workspace: {
      revision: 1,
      legs: [],
      warnings: [],
      tasks: [
        {
          id: 'demo-documents',
          title: 'Перевірити документи, квитки й страхування',
          status: 'open',
        },
        { id: 'demo-home', title: 'Підготувати дім перед від’їздом', status: 'open' },
        { id: 'demo-offline', title: 'Зберегти адреси й маршрут офлайн', status: 'done' },
      ],
      bookings: [],
      party: [],
      progress: { stage: 'planned', confirmed: false },
      preferences: { support_level: 'companion', morning: true, evening: true, paused: false },
      places: [
        {
          id: 'demo-place',
          title: 'Прогулянка старим містом',
          status: 'saved',
          note: 'Ідея для обговорення; години й доступ ще не перевірені.',
        },
      ],
      reviews: [],
      history: [],
      itinerary_versions: [],
    },
    research: { stale: false, revision: 0, options: [], selections: {} },
    ledger: {
      entries: [],
      totals_minor_by_currency: {},
      pending_deposits_minor_by_currency: {},
      unallocated_minor_by_currency: {},
      suggested_settlement: [],
    },
  },
};
