// Прогноз на дати поїздки (S-5-8, етап 5 PR-4): One Call 3.0 того самого
// ключа WEATHER_API_KEY, що погода в Mini App (безкоштовний у межах тарифу,
// у quota_counters не рахується - на відміну від Google Maps). Денний
// горизонт 8 діб: далі API не дає, і ланцюг чесно каже «ближче до дати».

import { kyivDateKey } from '../../kyiv-time.mjs';

const ONECALL = 'https://api.openweathermap.org/data/3.0/onecall';
const TIMEOUT_MS = 10_000;
/** Скільки діб уперед дає One Call 3.0 (daily). */
export const FORECAST_DAYS = 8;

/**
 * Прогноз на задані київські дати; порожньо - дати поза горизонтом або
 * ключа немає (викликач каже про це власнику, а не мовчить).
 * @param {Env} env @param {{ lat: number, lon: number }} at @param {string[]} dateKeys
 * @returns {Promise<{ date: string, min: number, max: number, desc: string }[]>}
 */
export async function forecastForDates(env, at, dateKeys) {
  if (!env.WEATHER_API_KEY) return [];
  const url = new URL(ONECALL);
  url.searchParams.set('lat', String(at.lat));
  url.searchParams.set('lon', String(at.lon));
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'ua');
  url.searchParams.set('exclude', 'current,minutely,hourly,alerts');
  url.searchParams.set('appid', env.WEATHER_API_KEY);
  let json;
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = /** @type {any} */ (await res.json());
  } catch (/** @type {any} */ e) {
    console.error('weather: прогноз на дати не отримано', e?.message);
    return [];
  }
  const daily = Array.isArray(json?.daily) ? json.daily : [];
  /** @type {{ date: string, min: number, max: number, desc: string }[]} */
  const out = [];
  for (const d of daily) {
    if (!Number.isFinite(Number(d?.dt))) continue;
    const date = kyivDateKey(new Date(Number(d.dt) * 1000));
    if (!dateKeys.includes(date)) continue;
    out.push({
      date,
      min: Math.round(Number(d.temp?.min ?? 0)),
      max: Math.round(Number(d.temp?.max ?? 0)),
      desc: String(d.weather?.[0]?.description ?? '—'),
    });
  }
  return out;
}

/** «12.09: 14…21 °, невеликий дощ». @param {{ date: string, min: number, max: number, desc: string }} f */
export function forecastLine(f) {
  const [, m, d] = f.date.split('-');
  return `${d}.${m}: ${f.min}…${f.max} °, ${f.desc}`;
}
