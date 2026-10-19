import { kyivDateKey, kyivClock } from '../../kyiv-time.mjs';

/** Kyiv wall time, including DST validation. @param {string} date @param {string} clock */
export function leisureLocalInstant(date, clock) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock))
    throw new Error('Укажи коректну дату й час.');
  const nominal = Date.parse(date + 'T' + clock + ':00Z');
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== date)
    throw new Error('Перевір дату.');
  const observed = Date.parse(kyivDateKey(new Date(nominal)) + 'T' + kyivClock(nominal) + ':00Z');
  const result = nominal - (observed - nominal);
  if (kyivDateKey(new Date(result)) !== date || kyivClock(result) !== clock)
    throw new Error('Цього місцевого часу не існує через переведення годинника.');
  return result;
}

/** @param {unknown} value */
function day(value) {
  const s = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + 'T12:00Z')) &&
    new Date(s + 'T12:00Z').toISOString().slice(0, 10) === s
    ? s
    : null;
}
/** @param {unknown} value */
function clock(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : null;
}
/** @param {any} raw */
export function normalizeLeisureSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ['once', 'recurring', 'visit', 'on-request', 'unverified'].includes(raw.kind)
    ? raw.kind
    : 'unverified';
  return {
    kind,
    timeMode: raw.timeMode === 'window' ? 'window' : 'fixed',
    precision: ['exact', 'date', 'inferred', 'conflicting'].includes(raw.precision)
      ? raw.precision
      : 'date',
    weekdays: [
      ...new Set(
        (Array.isArray(raw.weekdays) ? raw.weekdays : []).filter(
          (/** @type {any} */ x) => Number.isInteger(x) && x >= 0 && x <= 6,
        ),
      ),
    ],
    startTime: clock(raw.startTime),
    endTime: clock(raw.endTime),
    validFrom: day(raw.validFrom),
    validThrough: day(raw.validThrough),
    excludedDates: (Array.isArray(raw.excludedDates) ? raw.excludedDates : [])
      .map(day)
      .filter(Boolean)
      .slice(0, 100),
    occurrences: (Array.isArray(raw.occurrences) ? raw.occurrences : [])
      .slice(0, 100)
      .filter(
        (/** @type {any} */ x) =>
          Number.isFinite(Date.parse(x.startAt)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(x.startAt),
      )
      .map((/** @type {any} */ x) => ({
        startAt: new Date(x.startAt).toISOString(),
        endAt:
          Number.isFinite(Date.parse(x.endAt)) && Date.parse(x.endAt) > Date.parse(x.startAt)
            ? new Date(x.endAt).toISOString()
            : null,
      })),
    confirmationRequired: raw.confirmationRequired === true || kind === 'on-request',
    minParticipants:
      Number.isInteger(raw.minParticipants) &&
      raw.minParticipants > 0 &&
      raw.minParticipants <= 1000
        ? raw.minParticipants
        : null,
  };
}

/** True only for published eligible days; no extrapolation of recurring or conflicting schedules.
 * @param {any} item @param {string} date */
export function leisureAvailableOn(item, date) {
  if ((item.startDate && item.startDate > date) || (item.endDate && item.endDate < date))
    return false;
  const s = item.schedule;
  if (!s) return true;
  if (
    s.kind === 'on-request' ||
    s.kind === 'unverified' ||
    ['inferred', 'conflicting'].includes(s.precision) ||
    s.confirmationRequired ||
    s.minParticipants > 2
  )
    return false;
  if (
    (s.validFrom && date < s.validFrom) ||
    (s.validThrough && date > s.validThrough) ||
    s.excludedDates?.includes(date)
  )
    return false;
  if (s.occurrences?.length)
    return s.occurrences.some((/** @type {any} */ o) => kyivDateKey(new Date(o.startAt)) === date);
  if (s.kind === 'recurring') return !!s.weekdays?.includes(new Date(date + 'T12:00Z').getUTCDay());
  return true;
}

/** @param {any} item @param {string} date @returns {{startAt: number,endAt: number|null}[]} */
export function leisureOccurrencesOn(item, date) {
  if (!leisureAvailableOn(item, date)) return [];
  const s = item.schedule;
  if (s?.occurrences?.length)
    return s.occurrences
      .filter((/** @type {any} */ o) => kyivDateKey(new Date(o.startAt)) === date)
      .map((/** @type {any} */ o) => ({
        startAt: Date.parse(o.startAt),
        endAt: o.endAt ? Date.parse(o.endAt) : null,
      }));
  if (s?.kind === 'recurring' && s.startTime) {
    try {
      return [
        {
          startAt: leisureLocalInstant(date, s.startTime),
          endAt: s.endTime ? leisureLocalInstant(date, s.endTime) : null,
        },
      ];
    } catch {
      return [];
    }
  }
  if (item.startAt && kyivDateKey(new Date(item.startAt)) === date)
    return [
      {
        startAt: Date.parse(item.startAt),
        endAt:
          item.endAt && kyivDateKey(new Date(item.endAt)) === date ? Date.parse(item.endAt) : null,
      },
    ];
  return [];
}

/** Validate a selected slot again on the server. @param {any} item @param {number} a @param {number} b */
export function leisureSlotMatches(item, a, b) {
  const date = kyivDateKey(new Date(a));
  if (!leisureAvailableOn(item, date)) return false;
  const s = item.schedule;
  if (!s || s.kind === 'visit') return true;
  const occurrences = leisureOccurrencesOn(item, date);
  if (!occurrences.length) return s.precision === 'date';
  return occurrences.some((o) =>
    s.timeMode === 'window'
      ? a >= o.startAt && (!o.endAt || b <= o.endAt)
      : a === o.startAt && (!o.endAt || b >= o.endAt),
  );
}
