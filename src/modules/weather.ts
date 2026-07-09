// weather (producer, кілька локацій, §6). OpenWeather **One Call 3.0** (актуальне+
// погодинне+добове+алерти) + безкоштовний Air Pollution (AQI). Пише в RunBus
// weather.today.<slug> для кожної локації, повертає ОДИН Block. Один впалий фетч
// локації не валить інші. API-ключ (appid) — НІКОЛИ в лог/стан (§19.4): логуємо
// лише канонізований URL. **Жорсткий денний ліміт запитів** (лічильник у стані) —
// захист від циклів/збоїв, які могли б спалити квоту One Call (§B роадмепу).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig, LocationConfig } from '../core/config.js';
import { optionalSecret } from '../core/secrets.js';
import { canonicalizeUrl } from '../core/url.js';

// Пороги дії — явні константи (§6).
export const COLD_THRESHOLD_C = 10; // willBeCold = tempC < 10
// Парасолька — лише коли ймовірність опадів удень достатня (нічний/вечірній
// грозовий слот із низьким pop не дає хибного сигналу вдень).
export const RAIN_POP_THRESHOLD = 0.5; // willRain = pop удень >= 50%
const DAY_START_HOUR = 6; // активний день (київські години) — нічні слоти ігноруємо
const DAY_END_HOUR = 21;

// Жорсткий денний ліміт запитів до OpenWeather (One Call 3.0 free = 1000/день).
// Реально ~4-8/день; ліміт — суто запобіжник від циклів (§B роадмепу).
export const DAILY_REQUEST_LIMIT = 1000;

/** Коди опадів OpenWeather: 2xx гроза, 3xx мряка, 5xx дощ, 6xx сніг (§6). */
function isPrecipCode(id: number): boolean {
  return id >= 200 && id < 700;
}

/** Емодзі-стан за кодом погоди OpenWeather. */
function emojiFor(id: number): string {
  if (id >= 200 && id < 300) return '⛈'; // гроза
  if (id >= 300 && id < 400) return '🌦'; // мряка
  if (id >= 500 && id < 600) return '🌧'; // дощ
  if (id >= 600 && id < 700) return '🌨'; // сніг
  if (id >= 700 && id < 800) return '🌫'; // туман/імла
  if (id === 800) return '☀️'; // ясно
  if (id === 801) return '🌤'; // мало хмар
  if (id === 802) return '⛅'; // розсіяні хмари
  return '☁️'; // 803/804 — хмарно
}

export interface WeatherToday {
  name: string;
  tempC: number; // актуальна (current.temp)
  minC: number; // денний мінімум
  maxC: number; // денний максимум
  feelsLikeC: number; // відчувається як
  windMps: number; // швидкість вітру, м/с
  gustMps?: number; // пориви, м/с (One Call current.wind_gust)
  humidity?: number; // вологість, %
  uv?: number; // UV-індекс (current.uvi), округлений
  aqi?: number; // якість повітря 1..5 (окремий Air Pollution ендпоінт)
  condition: string;
  emoji: string; // емодзі-стан
  willRain: boolean;
  willBeCold: boolean;
  popPercent: number; // макс. ймовірність опадів удень, %
  rainWindow?: string; // «14:00–17:00» коли саме дощ (з погодинного)
  advice?: string; // «одягтися»-підказка (похідна від відч.)
  sunrise: number; // unix сек, схід сонця (0 якщо невідомо)
  sunset: number; // unix сек, захід сонця (0 якщо невідомо)
  dayLenDeltaMin?: number; // зміна довжини дня vs учора, хв (обчислюється в run зі стану)
  hourlyTemp?: number[]; // денна температура по годинах (для спарклайна дашборда)
  hourly?: { h: number; t: number }[]; // {київська година, температура} за сьогодні (графік)
  alerts?: string[]; // офіційні попередження негоди (One Call alerts[].event)
  summary?: string; // людиночитне резюме дня (One Call daily[0].summary)
}

/** Детермінований slug локації (індекс) — today відтворює його так само (§6). */
export function slugFor(_loc: LocationConfig, index: number): string {
  return `loc${index}`;
}

export function weatherBusKey(slug: string): string {
  return `weather.today.${slug}`;
}

// --- One Call 3.0 форма відповіді (лише потрібні поля) ---
interface OwWeather {
  id?: number;
  description?: string;
}
interface OwCurrent {
  sunrise?: number;
  sunset?: number;
  temp?: number;
  feels_like?: number;
  humidity?: number;
  uvi?: number;
  wind_speed?: number;
  wind_gust?: number;
  weather?: OwWeather[];
}
interface OwHour {
  dt: number;
  temp?: number;
  pop?: number;
  weather?: OwWeather[];
}
interface OwDay {
  sunrise?: number;
  sunset?: number;
  summary?: string;
  temp?: { min?: number; max?: number };
  pop?: number;
  weather?: OwWeather[];
}
interface OneCallResponse {
  current?: OwCurrent;
  hourly?: OwHour[];
  daily?: OwDay[];
  alerts?: { event?: string }[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number) => Math.round(v);

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

/** Сигнал опадів для години: pop, якщо є; інакше похідна з коду (1/0). */
function rainSignalHour(h: OwHour): number {
  if (isNum(h.pop)) return h.pop;
  return isPrecipCode(h.weather?.[0]?.id ?? 0) ? 1 : 0;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** «14:00–17:00» з дощових годин (перша..остання+1). Один слот → «14:00–15:00». */
function formatRainWindow(rainyHours: number[]): string | undefined {
  if (rainyHours.length === 0) return undefined;
  const first = Math.min(...rainyHours);
  const last = Math.min(Math.max(...rainyHours) + 1, 24);
  return `${pad2(first)}:00–${pad2(last)}:00`;
}

/** Похідна «одягтися»-підказка за відчутною температурою. */
export function adviceFor(feelsLikeC: number): string {
  if (!Number.isFinite(feelsLikeC)) return '';
  if (feelsLikeC < 0) return 'Морозно — тепла куртка, шапка, рукавиці';
  if (feelsLikeC < 10) return 'Прохолодно — куртка';
  if (feelsLikeC < 18) return 'Легка куртка або светр';
  if (feelsLikeC < 27) return 'Комфортно — без верхнього одягу';
  return 'Спекотно — легкий одяг, більше води';
}

/** Довжина світлового дня в секундах (0, якщо дані некоректні). */
export function dayLenSec(sunrise: number, sunset: number): number {
  return sunset > sunrise ? sunset - sunrise : 0;
}

/** AQI 1..5 з відповіді Air Pollution (list[0].main.aqi). */
export function mergeAqi(json: unknown): number | undefined {
  const aqi = (json as { list?: { main?: { aqi?: number } }[] })?.list?.[0]?.main?.aqi;
  return isNum(aqi) && aqi >= 1 && aqi <= 5 ? aqi : undefined;
}

/** Звести One Call 3.0-відповідь до WeatherToday для київської дати todayKey. */
export function parseOneCall(json: unknown, name: string, todayKey: string): WeatherToday | null {
  const oc = json as OneCallResponse;
  const cur = oc?.current;
  if (!cur || !isNum(cur.temp)) return null;

  const daily = Array.isArray(oc.daily) ? oc.daily : [];
  const day0 = daily[0];
  const hourly = Array.isArray(oc.hourly) ? oc.hourly : [];

  const repId = cur.weather?.[0]?.id ?? day0?.weather?.[0]?.id ?? 0;
  const tempC = round(cur.temp);
  const feelsLikeC = round(isNum(cur.feels_like) ? cur.feels_like : cur.temp);
  const condition = cur.weather?.[0]?.description ?? day0?.weather?.[0]?.description ?? '—';
  const windMps = round(isNum(cur.wind_speed) ? cur.wind_speed : 0);
  const gustMps = isNum(cur.wind_gust) ? round(cur.wind_gust) : undefined;
  const humidity = isNum(cur.humidity) ? round(cur.humidity) : undefined;
  const uv = isNum(cur.uvi) ? round(cur.uvi) : undefined;

  // Схід/захід — беремо з добового запису (день), фолбек — з current.
  const sunrise = day0 && isNum(day0.sunrise) ? day0.sunrise : isNum(cur.sunrise) ? cur.sunrise : 0;
  const sunset = day0 && isNum(day0.sunset) ? day0.sunset : isNum(cur.sunset) ? cur.sunset : 0;

  // Погодинні записи сьогодні (київська дата) для мін/макс, вікна дощу, спарклайна.
  const todayHours = hourly.filter((h) => entryKyiv(h.dt).dateKey === todayKey);
  const dayHours = todayHours.filter((h) => {
    const hr = entryKyiv(h.dt).hour;
    return hr >= DAY_START_HOUR && hr <= DAY_END_HOUR;
  });

  // Денний мін/макс: з daily[0].temp, фолбек — з погодинних температур доби.
  const hourTemps = todayHours.map((h) => h.temp).filter(isNum);
  let minC: number;
  let maxC: number;
  if (isNum(day0?.temp?.min) && isNum(day0?.temp?.max)) {
    minC = round(day0!.temp!.min!);
    maxC = round(day0!.temp!.max!);
  } else if (hourTemps.length) {
    minC = round(Math.min(...hourTemps));
    maxC = round(Math.max(...hourTemps));
  } else {
    minC = tempC;
    maxC = tempC;
  }

  // Дощ удень: максимум pop за денними слотами (фолбек — усі слоти доби, далі daily.pop).
  const rainScope = dayHours.length ? dayHours : todayHours;
  let maxRain = rainScope.reduce((m, h) => Math.max(m, rainSignalHour(h)), 0);
  if (rainScope.length === 0 && isNum(day0?.pop)) maxRain = day0!.pop!;
  const willRain = maxRain >= RAIN_POP_THRESHOLD;
  const popPercent = round(maxRain * 100);
  const rainyHours = rainScope
    .filter((h) => rainSignalHour(h) >= RAIN_POP_THRESHOLD)
    .map((h) => entryKyiv(h.dt).hour);
  const rainWindow = willRain ? formatRainWindow(rainyHours) : undefined;

  // Спарклайн температури: денні слоти, фолбек — усі слоти доби; лише якщо ≥2 точки.
  const sparkSource = dayHours.length >= 2 ? dayHours : todayHours;
  const hourlyTemp = sparkSource
    .map((h) => h.temp)
    .filter(isNum)
    .map(round);

  // Погодинний ряд {година, температура} за сьогодні — для графіка з віссю годин.
  const hourlySeries = todayHours
    .filter((h) => isNum(h.temp))
    .map((h) => ({ h: entryKyiv(h.dt).hour, t: round(h.temp as number) }));

  const alerts = (Array.isArray(oc.alerts) ? oc.alerts : [])
    .map((a) => a.event)
    .filter((e): e is string => typeof e === 'string' && e.length > 0);

  return {
    name,
    tempC,
    minC,
    maxC,
    feelsLikeC,
    windMps,
    ...(gustMps !== undefined ? { gustMps } : {}),
    ...(humidity !== undefined ? { humidity } : {}),
    ...(uv !== undefined ? { uv } : {}),
    condition,
    emoji: emojiFor(repId),
    willRain,
    willBeCold: tempC < COLD_THRESHOLD_C,
    popPercent,
    ...(rainWindow ? { rainWindow } : {}),
    advice: adviceFor(feelsLikeC),
    sunrise,
    sunset,
    ...(hourlyTemp.length >= 2 ? { hourlyTemp } : {}),
    ...(hourlySeries.length >= 2 ? { hourly: hourlySeries } : {}),
    ...(alerts.length ? { alerts } : {}),
    ...(day0?.summary ? { summary: day0.summary } : {}),
  };
}

function signed(n: number): string {
  return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n}°` : '—';
}

/** Рядок summary (плейн-текст): емодзі, локація, температура, мітки дії. */
function formatSummaryLine(w: WeatherToday): string {
  const marks = `${w.willRain ? ' ☔' : ''}${w.willBeCold ? ' 🧥' : ''}`;
  return `${w.emoji} ${w.name}: ${signed(w.tempC)}${marks}`;
}

/** Рядок detail: стан, відчувається, мін/макс, вітер, вологість, UV, дощ-вікно. */
function formatDetailLine(w: WeatherToday): string {
  const parts = [
    `${w.name}: ${w.condition}`,
    `відч. ${signed(w.feelsLikeC)}`,
    `${signed(w.minC)}…${signed(w.maxC)}`,
    `💨 ${w.windMps} м/с${w.gustMps !== undefined ? ` (пориви ${w.gustMps})` : ''}`,
  ];
  if (w.humidity !== undefined) parts.push(`💧 ${w.humidity}%`);
  if (w.uv !== undefined) parts.push(`UV ${w.uv}`);
  if (w.willRain) parts.push(`☔ ${w.popPercent}%${w.rainWindow ? ` (${w.rainWindow})` : ''}`);
  return parts.join(', ');
}

interface RequestCounter {
  date: string;
  count: number;
}

export interface WeatherModuleOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
}

export function createWeatherModule(opts: WeatherModuleOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

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

      // Денний лічильник запитів (скидається на нову добу). Захист від циклів (§B).
      const stored = ctx.state.get<RequestCounter>('weatherRequests');
      const counter: RequestCounter =
        stored && stored.date === todayKey ? { ...stored } : { date: todayKey, count: 0 };
      let limitHit = false;

      // Кожен запит проходить через лічильник; понад ліміт — кидаємо, не фетчимо.
      const guardedFetch = async (u: string): Promise<Response> => {
        if (counter.count >= DAILY_REQUEST_LIMIT) {
          limitHit = true;
          throw new Error(`денний ліміт запитів OpenWeather вичерпано (${DAILY_REQUEST_LIMIT})`);
        }
        counter.count++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          return await fetchImpl(u, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      };

      const fetchOneCall = async (loc: LocationConfig): Promise<WeatherToday> => {
        const url = new URL('https://api.openweathermap.org/data/3.0/onecall');
        url.searchParams.set('lat', String(loc.lat));
        url.searchParams.set('lon', String(loc.lon));
        url.searchParams.set('units', 'metric');
        url.searchParams.set('lang', 'ua');
        url.searchParams.set('exclude', 'minutely');
        url.searchParams.set('appid', apiKey);
        const res = await guardedFetch(url.toString());
        if (!res.ok) {
          // Лог БЕЗ ключа (§19.4).
          throw new Error(`OpenWeather HTTP ${res.status} для ${canonicalizeUrl(url.toString())}`);
        }
        const parsed = parseOneCall(await res.json(), loc.name, todayKey);
        if (!parsed) throw new Error(`порожній onecall для ${loc.name}`);
        return parsed;
      };

      // AQI — окремий БЕЗКОШТОВНИЙ ендпоінт; його збій не валить локацію.
      const fetchAqi = async (loc: LocationConfig): Promise<number | undefined> => {
        try {
          const url = new URL('https://api.openweathermap.org/data/2.5/air_pollution');
          url.searchParams.set('lat', String(loc.lat));
          url.searchParams.set('lon', String(loc.lon));
          url.searchParams.set('appid', apiKey);
          const res = await guardedFetch(url.toString());
          if (!res.ok) return undefined;
          return mergeAqi(await res.json());
        } catch {
          return undefined;
        }
      };

      const fetchLocation = async (loc: LocationConfig): Promise<WeatherToday> => {
        const w = await fetchOneCall(loc);
        const aqi = await fetchAqi(loc);
        if (aqi !== undefined) w.aqi = aqi;
        return w;
      };

      const results = await Promise.allSettled(locs.map((loc) => fetchLocation(loc)));

      // Персистимо лічильник запитів завжди (навіть якщо всі впали).
      ctx.state.set('weatherRequests', counter);
      if (limitHit) {
        ctx.log.warn(
          `weather: денний ліміт запитів OpenWeather (${DAILY_REQUEST_LIMIT}) вичерпано — частину локацій пропущено`,
        );
      }

      const ok: WeatherToday[] = [];
      results.forEach((r, i) => {
        const loc = locs[i]!;
        if (r.status === 'fulfilled') {
          const w = r.value;
          // Дельта довжини дня vs учора — зі стану (per slug). Оновлюємо стан.
          const slug = slugFor(loc, i);
          const len = dayLenSec(w.sunrise, w.sunset);
          if (len > 0) {
            const key = `weatherDayLen:${slug}`;
            const prev = ctx.state.get<{ date: string; lenSec: number }>(key);
            if (prev && prev.date !== todayKey) {
              w.dayLenDeltaMin = round((len - prev.lenSec) / 60);
            }
            ctx.state.set(key, { date: todayKey, lenSec: len });
          }
          ctx.bus.set(weatherBusKey(slug), w);
          ok.push(w);
        } else {
          ctx.log.warn(`погода для ${loc.name} впала: ${String(r.reason).slice(0, 120)}`);
        }
      });

      if (ok.length === 0) return null; // усі локації впали -> деградуємо тихо

      return {
        id: 'weather',
        title: 'Погода',
        icon: '🌦',
        summary: ok.map(formatSummaryLine).join('\n'),
        detail: ok.map(formatDetailLine).join('\n'),
        data: { locations: ok },
        inMessage: false, // глибина — в дашборді; повідомлення лаконічне
        priority: 40,
      };
    },
  };
}
