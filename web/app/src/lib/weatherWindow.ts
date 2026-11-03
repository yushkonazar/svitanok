import type { WeatherLocation } from '../api/briefing-schema.ts';
import { fmtClock } from './weather.ts';

type Hour = NonNullable<WeatherLocation['hourly']>[number];
export type ForecastHighlight = { from: number; to: number };
export type WeatherWindow = ForecastHighlight & {
  start: number;
  probability: number;
  minC: number;
  maxC: number;
};
const HOUR = 3600;

/** Prefer the earliest least-wet interval. Never bridge missing forecast samples or invent their times. */
export function findWeatherWindow(hourly: Hour[], nowMs: number): WeatherWindow | null {
  const now = nowMs / 1000;
  const points = hourly.filter((point) => Number.isFinite(point.at)).sort((a, b) => a.at! - b.at!);
  const cadence = Math.min(
    ...points.slice(1).flatMap((point, i) => {
      const gap = point.at! - points[i]!.at!;
      return gap > 0 ? [gap] : [];
    }),
  );
  const candidates: Array<WeatherWindow & { amount: number }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!,
      b = points[i + 1]!;
    const start = Math.max(a.at!, now),
      gap = b.at! - a.at!;
    if (
      gap <= 0 ||
      gap !== cadence ||
      gap > 3 * HOUR ||
      b.at! - start < HOUR / 2 ||
      a.at! > now + 24 * HOUR ||
      b.at! > now + 24 * HOUR ||
      !Number.isFinite(a.popPercent) ||
      !Number.isFinite(b.popPercent) ||
      !Number.isFinite(a.t) ||
      !Number.isFinite(b.t)
    )
      continue;
    candidates.push({
      from: a.at!,
      to: b.at!,
      start,
      probability: Math.max(a.popPercent!, b.popPercent!),
      minC: Math.min(a.t, b.t),
      maxC: Math.max(a.t, b.t),
      amount:
        a.precipMm != null && b.precipMm != null ? Math.max(a.precipMm, b.precipMm) : Infinity,
    });
  }
  return (
    candidates.sort(
      (a, b) => a.probability - b.probability || a.amount - b.amount || a.start - b.start,
    )[0] ?? null
  );
}

const day = (unix: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unix * 1000));
export function weatherWindowLabel(window: WeatherWindow, nowMs: number) {
  const today = day(nowMs / 1000);
  const tomorrow = day((Date.parse(today + 'T12:00:00Z') + 86400000) / 1000);
  const label = (unix: number) =>
    day(unix) === today
      ? 'Сьогодні'
      : day(unix) === tomorrow
        ? 'Завтра'
        : new Intl.DateTimeFormat('uk-UA', {
            timeZone: 'Europe/Kyiv',
            day: 'numeric',
            month: 'short',
          }).format(new Date(unix * 1000));
  const start =
    window.start <= nowMs / 1000 ? 'Зараз' : label(window.start) + ' ' + fmtClock(window.start);
  return (
    start +
    (day(window.start) === day(window.to) ? '–' : ' — ' + label(window.to).toLowerCase() + ' ') +
    fmtClock(window.to)
  );
}
