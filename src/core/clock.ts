// Київський час із коректним DST (§2, §19.11). Усі «київські» похідні рахуються
// через Intl з TZ Europe/Kyiv — без хардкоду офсету (+02:00 узимку / +03:00влітку).
// now() повертає реальний інстант (Date не має TZ); «київськість» — у похідних.

export interface Clock {
  now(): Date;
  kyivHour(): number; // 0–23, київська година
  todayKey(): string; // "YYYY-MM-DD" київський
  isSunday(): boolean;
}

const KYIV_TZ = 'Europe/Kyiv';

interface KyivParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  weekday: string; // "Sun" | "Mon" | ...
}

function kyivParts(d: Date): KyivParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  return {
    year: parts.year ?? '',
    month: parts.month ?? '',
    day: parts.day ?? '',
    hour: parseInt(parts.hour ?? '0', 10) % 24, // "24" опівночі в деяких ICU -> 0
    weekday: parts.weekday ?? '',
  };
}

/**
 * Фабрика годинника з інжектованим джерелом часу (для детермінованих тестів).
 * @param nowFn - джерело інстанту; за замовчуванням реальний час.
 */
export function createClock(nowFn: () => Date = () => new Date()): Clock {
  return {
    now: () => nowFn(),
    kyivHour: () => kyivParts(nowFn()).hour,
    todayKey: () => {
      const p = kyivParts(nowFn());
      return `${p.year}-${p.month}-${p.day}`;
    },
    isSunday: () => kyivParts(nowFn()).weekday === 'Sun',
  };
}
