// weather (producer, кілька локацій, §6). OpenWeather 5-day/3-hour forecast.
// Пише в RunBus weather.today.<slug> для кожної локації, повертає ОДИН Block з
// рядками-діями. Один впалий фетч локації не валить інші. API-ключ (appid) —
// НІКОЛИ в лог/стан (§19.4): логуємо лише канонізований URL.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig, LocationConfig } from '../core/config.js';
import { optionalSecret } from '../core/secrets.js';
import { canonicalizeUrl } from '../core/url.js';

// Пороги дії — явні константи (§6).
export const COLD_THRESHOLD_C = 10; // willBeCold = tempC < 10
// Парасолька — лише коли ймовірність опадів удень достатня. Раніше «будь-який
// слот доби має код опадів» давав парасольку в спекотний день з грозовим слотом
// надвечір — хибний сигнал.
export const RAIN_POP_THRESHOLD = 0.5; // willRain = pop удень >= 50%
const DAY_START_HOUR = 6; // активний день (київські години) — нічні слоти ігноруємо
const DAY_END_HOUR = 21;
const REPRESENTATIVE_HOUR = 12; // денний показник: запис, найближчий до полудня

/** Коди опадів OpenWeather: 2xx гроза, 3xx мряка, 5xx дощ, 6xx сніг (§6). */
function isPrecipCode(id: number): boolean {
  return id >= 200 && id < 700;
}

export interface WeatherToday {
  name: string;
  tempC: number;
  condition: string;
  willRain: boolean;
  willBeCold: boolean;
  popPercent: number; // макс. ймовірність опадів удень, % (для прозорості парасольки)
}

/** Детермінований slug локації (індекс) — today відтворює його так само (§6). */
export function slugFor(_loc: LocationConfig, index: number): string {
  return `loc${index}`;
}

export function weatherBusKey(slug: string): string {
  return `weather.today.${slug}`;
}

interface ForecastEntry {
  dt: number;
  main?: { temp?: number };
  weather?: { id?: number; description?: string }[];
  pop?: number; // ймовірність опадів 0..1 (OpenWeather forecast)
}

/** Сигнал опадів для слоту: pop, якщо є; інакше похідна з коду (1/0). */
function rainSignal(e: ForecastEntry): number {
  if (typeof e.pop === 'number') return e.pop;
  return isPrecipCode(e.weather?.[0]?.id ?? 0) ? 1 : 0;
}

function entryKyiv(dtSeconds: number): { dateKey: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(dtSeconds * 1000))) p[part.type] = part.value;
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(p.hour ?? '0', 10) % 24,
  };
}

/** Звести forecast-відповідь до WeatherToday для київської дати todayKey. */
export function parseForecast(json: unknown, name: string, todayKey: string): WeatherToday | null {
  const list = (json as { list?: ForecastEntry[] })?.list;
  if (!Array.isArray(list)) return null;

  const today = list.filter((e) => entryKyiv(e.dt).dateKey === todayKey);
  const pool = today.length ? today : list.slice(0, 1); // фолбек: найближчий запис
  if (pool.length === 0) return null;

  // Представницький запис — найближчий до полудня.
  const rep = pool.reduce((best, e) =>
    Math.abs(entryKyiv(e.dt).hour - REPRESENTATIVE_HOUR) <
    Math.abs(entryKyiv(best.dt).hour - REPRESENTATIVE_HOUR)
      ? e
      : best,
  );

  const tempC = Math.round(rep.main?.temp ?? NaN);
  const condition = rep.weather?.[0]?.description ?? '—';

  // willRain — за денними слотами (нічний дощ не змушує брати парасольку вдень).
  const daySlots = pool.filter((e) => {
    const h = entryKyiv(e.dt).hour;
    return h >= DAY_START_HOUR && h <= DAY_END_HOUR;
  });
  const slots = daySlots.length ? daySlots : pool;
  const maxRain = slots.reduce((m, e) => Math.max(m, rainSignal(e)), 0);

  return {
    name,
    tempC,
    condition,
    willRain: maxRain >= RAIN_POP_THRESHOLD,
    willBeCold: Number.isFinite(tempC) && tempC < COLD_THRESHOLD_C,
    popPercent: Math.round(maxRain * 100),
  };
}

function formatLine(w: WeatherToday): string {
  const sign = w.tempC > 0 ? '+' : '';
  const temp = Number.isFinite(w.tempC) ? `${sign}${w.tempC}°` : '—';
  const actions: string[] = [];
  if (w.willRain) actions.push(`☔ парасолька (${w.popPercent}%)`);
  if (w.willBeCold) actions.push('🧥 вдягнись тепло');
  const tail = actions.length ? ` — ${actions.join(', ')}` : '';
  return `${w.name}: ${temp}, ${w.condition}${tail}`;
}

export interface WeatherModuleOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
}

export function createWeatherModule(opts: WeatherModuleOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  async function fetchLocation(loc: LocationConfig, apiKey: string, todayKey: string) {
    const url = new URL('https://api.openweathermap.org/data/2.5/forecast');
    url.searchParams.set('lat', String(loc.lat));
    url.searchParams.set('lon', String(loc.lon));
    url.searchParams.set('units', 'metric');
    url.searchParams.set('lang', 'ua');
    url.searchParams.set('appid', apiKey);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), { signal: ctrl.signal });
      if (!res.ok) {
        // Лог БЕЗ ключа (§19.4).
        throw new Error(`OpenWeather HTTP ${res.status} для ${canonicalizeUrl(url.toString())}`);
      }
      const data: unknown = await res.json();
      const parsed = parseForecast(data, loc.name, todayKey);
      if (!parsed) throw new Error(`порожній forecast для ${loc.name}`);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: 'weather',
    kind: 'producer',
    enabled: (config) => config.modules.weather.enabled,
    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const apiKey = opts.apiKey ?? optionalSecret('WEATHER_API_KEY');
      if (!apiKey) {
        ctx.log.warn('WEATHER_API_KEY відсутній — weather пропущено');
        return null;
      }
      const locs = ctx.config.locations;
      const todayKey = ctx.clock.todayKey();

      const results = await Promise.allSettled(
        locs.map((loc) => fetchLocation(loc, apiKey, todayKey)),
      );

      const ok: WeatherToday[] = [];
      results.forEach((r, i) => {
        const loc = locs[i]!;
        if (r.status === 'fulfilled') {
          ctx.bus.set(weatherBusKey(slugFor(loc, i)), r.value);
          ok.push(r.value);
        } else {
          ctx.log.warn(`погода для ${loc.name} впала: ${String(r.reason).slice(0, 120)}`);
        }
      });

      if (ok.length === 0) return null; // усі локації впали -> деградуємо тихо

      return {
        id: 'weather',
        title: 'Погода',
        icon: '🌦',
        summary: ok.map(formatLine).join('\n'),
        priority: 40,
      };
    },
  };
}
