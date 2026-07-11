// Спільна конверсія «київський локальний час -> UTC мс» (DST-aware через Intl,
// БЕЗ хардкоду офсету +02:00/+03:00, §19.11). Той самий трюк, що вже є в
// src/modules/calendar.ts (tzOffsetMs, інша форма — межі доби) і в
// web/reminders-core.mjs (kyivOffsetMinutes/kyivHmToUtcMs, окремий JS-
// рантайм за TS/JS межею). Тут — спільна TS-точка для calendar.ts+mail.ts
// (обидва в src/, той самий бандл, є сенс не дублювати).

const KYIV_TZ = 'Europe/Kyiv';

function tzOffsetMs(timeZone: string, date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(date.toLocaleString('en-US', { timeZone }));
  return tz.getTime() - utc.getTime();
}

/** Київський "YYYY-MM-DD" + HH:MM (місцевий час) -> мс UTC. */
export function kyivLocalToUtcMs(dateISO: string, hh: number, mm: number): number {
  const naiveUtcMs = Date.parse(
    `${dateISO}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`,
  );
  const offset = tzOffsetMs(KYIV_TZ, new Date(naiveUtcMs));
  return naiveUtcMs - offset;
}
