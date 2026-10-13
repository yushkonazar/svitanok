import { kyivDateKey } from '../../kyiv-time.mjs';
const DAY = 86400000;
/** @param {string} date */
export function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)))
    return false;
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date
  );
}
/** Convert local midnight with the actual Kyiv offset, including DST. @param {string} date */
export function kyivMidnight(date) {
  const target = Date.parse(`${date}T00:00:00Z`);
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
    );
    instant +=
      target -
      Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
  }
  return new Date(instant).toISOString();
}
/** @param {string} date @param {number} days */
export function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
/** @param {URLSearchParams} params @param {number} [nowMs] */
export function systemPeriod(params, nowMs = Date.now()) {
  const today = kyivDateKey(new Date(nowMs));
  const range = params.get('range') ?? 'month';
  if (!['today', '7d', 'month', 'custom'].includes(range)) throw new Error('invalid-period');
  const from =
    range === 'today'
      ? today
      : range === '7d'
        ? shiftDate(today, -6)
        : range === 'month'
          ? `${today.slice(0, 7)}-01`
          : (params.get('from') ?? '');
  const to = range === 'custom' ? (params.get('to') ?? '') : today;
  if (!validDate(from) || !validDate(to) || from > to || to > today)
    throw new Error('invalid-period');
  return {
    range,
    from,
    to,
    since: kyivMidnight(from),
    until: kyivMidnight(shiftDate(to, 1)),
    telemetryDays: 90,
  };
}
