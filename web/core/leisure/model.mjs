import { rankLeisureItems, leisurePreferenceProfile } from './discovery.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';

export const LEISURE_CATEGORIES = [
  'exhibition',
  'festival',
  'concert',
  'show',
  'cinema',
  'food',
  'trip',
];
export const LEISURE_OPERATIONS = [
  'settings',
  'save',
  'reaction',
  'visit',
  'plan',
  'cancel',
  'outcome',
  'refresh',
  'calendar-check',
  'familiarity',
  'place-check',
  'journey-check',
  'source-check',
  'clear',
];
export const DEFAULT_LEISURE_SETTINGS = {
  enabled: true,
  city: 'Львів',
  transport: 'car',
  updateHour: 8,
  categories: [...LEISURE_CATEGORIES],
  cinemas: ['forum-lviv', 'king-cross'],
  students: 2,
  retention: 'until-deleted',
  telegram: false,
};

export class LeisureError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
/** @param {unknown} value @param {number} [max] */
export const cleanText = (value, max = 500) =>
  String(value ?? '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
/** @param {unknown} value */
export function httpLink(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' && !u.username && !u.password && u.href.length < 1500
      ? u.href
      : null;
  } catch {
    return null;
  }
}
/** @param {unknown} value @param {boolean} [optional] */
export function dateKey(value, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const key = String(value ?? '');
  const parsed = new Date(`${key}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(key) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== key
  )
    throw new LeisureError('Укажи коректну дату.');
  return key;
}
/** @param {unknown} value */
export function instant(value) {
  const raw = String(value ?? '');
  dateKey(raw.slice(0, 10));
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  )
    throw new LeisureError('Потрібен час із часовим поясом.');
  return new Date(raw).toISOString();
}
/** @param {number} [nowMs] */
export function leisureWeek(nowMs = Date.now()) {
  const today = kyivDateKey(new Date(nowMs));
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDaysToDateKey(today, -((day + 6) % 7));
}
/** @param {string} prefix @param {string} identity */
export async function leisureId(prefix, identity) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `${prefix}-${[...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)}`;
}
/** @param {any} value */
export function priceForTwo(value) {
  if (!value || value.min == null) return { min: null, max: null, complete: false };
  const multiplier = value.basis === 'person' ? 2 : value.basis === 'pair' ? 1 : null;
  return multiplier == null
    ? { min: null, max: null, complete: false }
    : {
        min: value.min * multiplier,
        max: value.max == null ? null : value.max * multiplier,
        complete: true,
      };
}
/** Strict source facts; an absent/zero catalogue price never becomes free accidentally.
 * @param {any} raw @param {number} nowMs */
export async function normalizeLeisureItem(raw, nowMs) {
  const sourceUrl = httpLink(raw.sourceUrl);
  const title = cleanText(raw.title, 180);
  if (!title || !sourceUrl || !LEISURE_CATEGORIES.includes(raw.category)) return null;
  const startDate = raw.startDate ? dateKey(String(raw.startDate).slice(0, 10), true) : null;
  const endDate = raw.endDate ? dateKey(String(raw.endDate).slice(0, 10), true) : startDate;
  if (startDate && endDate && endDate < startDate) return null;
  const address = cleanText(raw.address, 250) || null;
  const venue = cleanText(raw.venue, 180) || null;
  const venueId = raw.placeId
    ? `google:${cleanText(raw.placeId, 300)}`
    : address
      ? await leisureId('venue', `${venue ?? ''}|${address}`.toLocaleLowerCase('uk'))
      : null;
  const knownPrice =
    typeof raw.priceMin === 'number' &&
    Number.isFinite(raw.priceMin) &&
    raw.priceMin >= 0 &&
    (raw.priceMin > 0 || raw.free === true);
  return {
    id: await leisureId(
      'item',
      raw.placeId ? `place:${raw.placeId}` : (raw.identity ?? sourceUrl.split('#')[0]),
    ),
    venueId,
    placeId: raw.placeId ?? null,
    category: raw.category,
    title,
    summary: cleanText(raw.summary, 650),
    venue,
    address,
    lat: Number.isFinite(raw.lat) && Math.abs(raw.lat) <= 90 ? raw.lat : null,
    lon: Number.isFinite(raw.lon) && Math.abs(raw.lon) <= 180 ? raw.lon : null,
    startDate,
    endDate,
    startAt:
      raw.startAt &&
      /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.startAt) &&
      Number.isFinite(Date.parse(raw.startAt))
        ? instant(raw.startAt)
        : null,
    endAt:
      raw.endAt &&
      /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.endAt) &&
      Number.isFinite(Date.parse(raw.endAt))
        ? instant(raw.endAt)
        : null,
    sourceUrl,
    source: cleanText(raw.source, 70),
    checkedAt: new Date(nowMs).toISOString(),
    price: {
      min: knownPrice ? raw.priceMin : null,
      max: typeof raw.priceMax === 'number' && raw.priceMax >= raw.priceMin ? raw.priceMax : null,
      currency: 'UAH',
      basis: ['person', 'pair'].includes(raw.priceBasis) ? raw.priceBasis : 'unknown',
      note: cleanText(raw.priceNote, 300),
    },
    status: ['available', 'sold-out', 'cancelled', 'postponed', 'schedule-pending'].includes(
      raw.status,
    )
      ? raw.status
      : 'available',
    registration: raw.registration === true,
    hours: cleanText(raw.hours, 250),
    studentNote: cleanText(raw.studentNote, 300),
    durationMinutes: Number(raw.durationMinutes) > 0 ? Math.round(raw.durationMinutes) : null,
    genre: cleanText(raw.genre, 120),
    placeType: cleanText(raw.placeType, 100),
    bookingUrl: httpLink(raw.bookingUrl),
    siteUrl: httpLink(raw.siteUrl),
    age: cleanText(raw.age, 30),
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions
          .slice(0, 200)
          .filter(
            (/** @type {any} */ s) => s.id && s.cinema && Number.isFinite(Date.parse(s.startAt)),
          )
          .map((/** @type {any} */ s) => ({
            id: cleanText(s.id, 160),
            cinema: cleanText(s.cinema, 100),
            cinemaSlug: cleanText(s.cinemaSlug, 80),
            address: cleanText(s.address, 200),
            startAt: instant(s.startAt),
            endAt: s.endAt ? instant(s.endAt) : null,
            format: cleanText(s.format, 70),
            language: cleanText(s.language, 70),
            price: typeof s.price === 'number' && s.price > 0 ? s.price : null,
            url: httpLink(s.url),
          }))
      : [],
  };
}
/** Recency, explicit feedback and diversity, with no fabricated partner preferences.
 * @param {any[]} items @param {any[]} records @param {string[]} previousIds @param {any} settings @param {number} nowMs */
export function selectLeisureEdition(items, records, previousIds, settings, nowMs) {
  const week = leisureWeek(nowMs),
    end = addDaysToDateKey(week, 6),
    horizon = addDaysToDateKey(week, 20);
  const hidden = new Set(
    records
      .filter(
        (r) =>
          r.kind === 'reaction' &&
          (r.verdict === 'uninterested' ||
            (r.verdict === 'later' &&
              Number.isFinite(Date.parse(r.at ?? '')) &&
              kyivDateKey(new Date(r.at)) >= week)),
      )
      .map((r) => r.itemId),
  );
  const eligible = items.filter(
    (i) =>
      settings.categories.includes(i.category) &&
      !hidden.has(i.id) &&
      !['sold-out', 'cancelled', 'postponed'].includes(i.status) &&
      (!i.endDate || i.endDate >= kyivDateKey(new Date(nowMs))) &&
      (!i.endAt || Date.parse(i.endAt) > nowMs || i.category === 'cinema') &&
      (!i.startDate || i.startDate <= horizon) &&
      (i.category !== 'cinema' ||
        !i.sessions?.length ||
        i.sessions.some((/** @type {any} */ s) => Date.parse(s.startAt) > nowMs)),
  );
  const dedupe = new Set();
  const unique = eligible.filter((i) => {
    const key = i.placeId
      ? `place:${i.placeId}`
      : i.category === 'cinema'
        ? `film:${i.title.toLocaleLowerCase('uk')}`
        : `${i.title.toLocaleLowerCase('uk').replace(/[^\p{L}\p{N}]/gu, '')}|${i.startAt ?? i.startDate ?? ''}|${(i.venue ?? i.address ?? '').toLocaleLowerCase('uk')}`;
    if (dedupe.has(key)) return false;
    dedupe.add(key);
    return true;
  });
  const ranking = rankLeisureItems(unique, records, previousIds, settings, nowMs);
  const lookup = new Map(unique.map((i) => [i.id, i]));
  return {
    week,
    until: end,
    ids: ranking
      .filter((r) => !lookup.get(r.id).startDate || lookup.get(r.id).startDate <= end)
      .map((r) => r.id),
    futureIds: ranking.filter((r) => lookup.get(r.id).startDate > end).map((r) => r.id),
    rankings: ranking,
    profileSignals: leisurePreferenceProfile(items, records, nowMs).signals,
    createdAt: new Date(nowMs).toISOString(),
    reason: 'Повний перевірений каталог, впорядкований за твоїми явними оцінками й актуальністю.',
  };
}
/** @param {any} raw */
export function normalizeLeisurePlan(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.stops) ||
    !raw.stops.length ||
    raw.stops.length > 12
  )
    throw new LeisureError('Додай хоча б один пункт до плану.');
  if (raw.calendar != null && typeof raw.calendar !== 'boolean')
    throw new LeisureError('Уточни, чи додати план у календар.');
  const stops = raw.stops
    .map((/** @type {any} */ s) => {
      const startAt = instant(s.startAt),
        endAt = instant(s.endAt);
      if (Date.parse(endAt) <= Date.parse(startAt))
        throw new LeisureError('Завершення має бути пізніше початку.');
      return {
        itemId: cleanText(s.itemId, 320),
        sessionId: cleanText(s.sessionId, 160) || null,
        startAt,
        endAt,
        tickets: s.tickets === true,
        reservation: s.reservation === true,
      };
    })
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.startAt.localeCompare(b.startAt));
  if (
    stops.some(
      (/** @type {any} */ s, /** @type {number} */ i) =>
        i && Date.parse(s.startAt) < Date.parse(stops[i - 1].endAt),
    )
  )
    throw new LeisureError('Пункти плану перетинаються в часі.');
  const title = cleanText(raw.title, 180);
  if (!title || stops.some((/** @type {any} */ s) => !s.itemId))
    throw new LeisureError('Укажи назву плану й обери місця.');
  const estimatedBudgetMinor =
    raw.estimatedBudgetMinor == null ? null : Number(raw.estimatedBudgetMinor);
  if (
    estimatedBudgetMinor != null &&
    (!Number.isSafeInteger(estimatedBudgetMinor) ||
      estimatedBudgetMinor < 0 ||
      estimatedBudgetMinor > 10000000000)
  )
    throw new LeisureError('Перевір орієнтовний бюджет.');
  return {
    title,
    estimatedBudgetMinor,
    stops,
    startAt: stops[0].startAt,
    endAt: stops[stops.length - 1].endAt,
    calendar: raw.calendar !== false,
    conflictConfirmed: raw.conflictConfirmed === true,
    calendarUnavailableConfirmed: raw.calendarUnavailableConfirmed === true,
    revision: Number(raw.revision ?? 0),
  };
}
