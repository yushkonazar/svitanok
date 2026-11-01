import { kyivInstant, kyivParts, shiftDate } from './finance/planning.mjs';

/** Calendar bounds with an exclusive, frozen cutoff, shared by report sources.
 * @param {string} from @param {string} to @param {number} asOfMs */
export function reportPeriod(from, to, asOfMs) {
  const start = kyivInstant(from, 0);
  const end = kyivInstant(shiftDate(to, 1), 0);
  if (end <= start || !Number.isFinite(asOfMs)) throw new Error('Некоректний період звіту');
  return {
    from: new Date(start).toISOString(),
    to: new Date(Math.min(end, asOfMs + 1)).toISOString(),
    dateFrom: from,
    dateTo: to,
    asOf: new Date(asOfMs).toISOString(),
    timeZone: 'Europe/Kyiv',
    complete: asOfMs >= end,
  };
}

/** Shift a cutoff by calendar days, preserving Kyiv wall time across DST.
 * @param {number} asOfMs @param {number} days */
export function shiftReportCutoff(asOfMs, days) {
  const p = kyivParts(asOfMs);
  return kyivInstant(shiftDate(p.date, days), p.hour, p.minute) + (asOfMs % 60_000);
}

/** Most recent completed calendar week, independent of queue/delivery day.
 * Kyiv calendar arithmetic preserves the 167/169-hour weeks around DST.
 * @param {number} asOfMs */
export function completedWeekPeriod(asOfMs) {
  const today = kyivParts(asOfMs).date;
  const sinceMonday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const from = shiftDate(today, -sinceMonday - 7);
  return reportPeriod(from, shiftDate(from, 6), asOfMs);
}
