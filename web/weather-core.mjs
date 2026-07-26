// Чиста логіка погоди для Worker'а (PR-7, «жива погода в Mini App») — дзеркало
// src/modules/weather.ts (та сама межа src/↔web/, що tg-core.mjs/calendar-core.mjs/
// reminders-core.mjs): оркестратор фетчить OpenWeather РАЗ/добу для щоденного
// брифінгу, а Worker (worker.js) фетчить те саме API НАЖИВО на вимогу Mini App,
// кешовано в KV (~30 хв TTL) — той самий парс, лише інший викликач і частота.
//
// Порт НАВМИСНО не 1:1 з усім weather.ts: лишень те, що показує WeatherBlock.tsx
// (weatherLocationSchema, web/app/src/api/briefing-schema.ts) — без денного
// лічильника запитів OpenWeather (той захист лишається на оркестраторі, тут —
// окремий, менший ліміт у worker.js) і без dayLenDeltaMin (потребує стану
// «вчора», який має сенс лише для ОДНОГО щоденного зрізу, не для живих запитів
// упродовж дня).

export const COLD_THRESHOLD_C = 10;
export const RAIN_POP_THRESHOLD = 0.5;
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 21;

function isPrecipCode(id) {
  return id >= 200 && id < 700;
}

/** Емодзі-стан за кодом погоди OpenWeather. */
export function emojiFor(id) {
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

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v) => Math.round(v);

function entryKyiv(dtSeconds) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(dtSeconds * 1000))) p[part.type] = part.value;
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour ?? '0', 10) % 24 };
}

function rainSignalHour(h) {
  if (isNum(h.pop)) return h.pop;
  return isPrecipCode(h.weather?.[0]?.id ?? 0) ? 1 : 0;
}

const pad2 = (n) => String(n).padStart(2, '0');

function formatRainWindow(rainyHours) {
  if (rainyHours.length === 0) return undefined;
  const first = Math.min(...rainyHours);
  const last = Math.min(Math.max(...rainyHours) + 1, 24);
  return `${pad2(first)}:00–${pad2(last)}:00`;
}

/** Похідна «одягтися»-підказка за відчутною температурою. */
export function adviceFor(feelsLikeC) {
  if (!Number.isFinite(feelsLikeC)) return '';
  if (feelsLikeC < 0) return 'Морозно — тепла куртка, шапка, рукавиці';
  if (feelsLikeC < 10) return 'Прохолодно — куртка';
  if (feelsLikeC < 18) return 'Легка куртка або светр';
  if (feelsLikeC < 27) return 'Комфортно — без верхнього одягу';
  return 'Спекотно — легкий одяг, більше води';
}

/** AQI 1..5 з відповіді Air Pollution (list[0].main.aqi). */
export function mergeAqi(json) {
  const aqi = json?.list?.[0]?.main?.aqi;
  return isNum(aqi) && aqi >= 1 && aqi <= 5 ? aqi : undefined;
}

/** Звести One Call 3.0-відповідь до WeatherLocation (weatherLocationSchema
 *  форма) для київської дати todayKey. null, якщо відповідь непридатна. */
export function parseOneCall(json, name, todayKey) {
  const cur = json?.current;
  if (!cur || !isNum(cur.temp)) return null;

  const daily = Array.isArray(json.daily) ? json.daily : [];
  const day0 = daily[0];
  const hourly = Array.isArray(json.hourly) ? json.hourly : [];

  const repId = cur.weather?.[0]?.id ?? day0?.weather?.[0]?.id ?? 0;
  const tempC = round(cur.temp);
  const feelsLikeC = round(isNum(cur.feels_like) ? cur.feels_like : cur.temp);
  const condition = cur.weather?.[0]?.description ?? day0?.weather?.[0]?.description ?? '—';
  const windMps = round(isNum(cur.wind_speed) ? cur.wind_speed : 0);
  const gustMps = isNum(cur.wind_gust) ? round(cur.wind_gust) : undefined;
  const humidity = isNum(cur.humidity) ? round(cur.humidity) : undefined;
  const uv = isNum(cur.uvi) ? round(cur.uvi) : undefined;

  const sunrise = day0 && isNum(day0.sunrise) ? day0.sunrise : isNum(cur.sunrise) ? cur.sunrise : 0;
  const sunset = day0 && isNum(day0.sunset) ? day0.sunset : isNum(cur.sunset) ? cur.sunset : 0;

  const todayHours = hourly.filter((h) => entryKyiv(h.dt).dateKey === todayKey);
  const dayHours = todayHours.filter((h) => {
    const hr = entryKyiv(h.dt).hour;
    return hr >= DAY_START_HOUR && hr <= DAY_END_HOUR;
  });

  const hourTemps = todayHours.map((h) => h.temp).filter(isNum);
  let minC;
  let maxC;
  if (isNum(day0?.temp?.min) && isNum(day0?.temp?.max)) {
    minC = round(day0.temp.min);
    maxC = round(day0.temp.max);
  } else if (hourTemps.length) {
    minC = round(Math.min(...hourTemps));
    maxC = round(Math.max(...hourTemps));
  } else {
    minC = tempC;
    maxC = tempC;
  }

  const rainScope = dayHours.length ? dayHours : todayHours;
  let maxRain = rainScope.reduce((m, h) => Math.max(m, rainSignalHour(h)), 0);
  if (rainScope.length === 0 && isNum(day0?.pop)) maxRain = day0.pop;
  const willRain = maxRain >= RAIN_POP_THRESHOLD;
  const popPercent = round(maxRain * 100);
  const rainyHours = rainScope
    .filter((h) => rainSignalHour(h) >= RAIN_POP_THRESHOLD)
    .map((h) => entryKyiv(h.dt).hour);
  const rainWindow = willRain ? formatRainWindow(rainyHours) : undefined;

  const hourlySeries = todayHours
    .filter((h) => isNum(h.temp))
    .map((h) => ({ h: entryKyiv(h.dt).hour, t: round(h.temp) }));

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
    ...(hourlySeries.length >= 2 ? { hourly: hourlySeries } : {}),
  };
}
