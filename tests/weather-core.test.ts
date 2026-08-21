import { describe, it, expect } from 'vitest';
import { parseOneCall, emojiFor, adviceFor } from '../web/weather-core.mjs';
import { mergeAqi, COLD_THRESHOLD_C } from '../web/weather-core.mjs';

// Дзеркало tests/weather.test.ts (src/modules/weather.ts) — той самий парсер,
// портований у web/ для живого фетчу Worker'ом (PR-7). Поля, яких цей порт
// НЕ несе (hourlyTemp/alerts/summary/dayLenDeltaMin — поза weatherLocationSchema
// чи потребують стану «вчора», якого немає в живому запиті), тут не перевіряємо.

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const SUNRISE = sec('2026-07-01T02:00:00Z');
const SUNSET = sec('2026-07-01T18:00:00Z');

const oneCall = {
  current: {
    sunrise: SUNRISE,
    sunset: SUNSET,
    temp: 8,
    feels_like: 6,
    humidity: 70,
    uvi: 5.6,
    wind_speed: 5.2,
    wind_gust: 9.1,
    weather: [{ id: 500, description: 'дощ' }],
  },
  hourly: [
    { dt: sec('2026-07-01T06:00:00Z'), temp: 10, pop: 0.1, weather: [{ id: 800 }] },
    { dt: sec('2026-07-01T09:00:00Z'), temp: 8, pop: 0.8, weather: [{ id: 500 }] },
    { dt: sec('2026-07-01T12:00:00Z'), temp: 12, pop: 0.7, weather: [{ id: 500 }] },
    { dt: sec('2026-07-01T15:00:00Z'), temp: 11, pop: 0.2, weather: [{ id: 803 }] },
  ],
  daily: [
    {
      sunrise: SUNRISE,
      sunset: SUNSET,
      temp: { min: 7, max: 16 },
      pop: 0.8,
      weather: [{ id: 500, description: 'дощ' }],
    },
  ],
};

describe('weather-core (Worker-порт) — parseOneCall', () => {
  it('актуальна температура/стан/willRain/willBeCold — той самий результат, що src/modules/weather.ts', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01');
    expect(w!.name).toBe('Львів');
    expect(w!.tempC).toBe(8);
    expect(w!.condition).toBe('дощ');
    expect(w!.emoji).toBe('🌧');
    expect(w!.willRain).toBe(true);
    expect(w!.popPercent).toBe(80);
    expect(w!.willBeCold).toBe(true);
  });

  it('збагачені поля: відч./вітер+пориви/вологість/UV/мін-макс', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01');
    expect(w!.feelsLikeC).toBe(6);
    expect(w!.windMps).toBe(5);
    expect(w!.gustMps).toBe(9);
    expect(w!.humidity).toBe(70);
    expect(w!.uv).toBe(6);
    expect(w!.minC).toBe(7);
    expect(w!.maxC).toBe(16);
  });

  it('вікно дощу + hourly {h,t} за сьогодні', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01');
    expect(w!.rainWindow).toBe('12:00–16:00');
    expect(w!.hourly).toEqual([
      { h: 9, t: 10 },
      { h: 12, t: 8 },
      { h: 15, t: 12 },
      { h: 18, t: 11 },
    ]);
  });

  it('advice + схід/захід з добового запису', () => {
    const w = parseOneCall(oneCall, 'Львів', '2026-07-01');
    expect(w!.advice).toBe('Прохолодно — куртка');
    expect(w!.sunrise).toBe(SUNRISE);
    expect(w!.sunset).toBe(SUNSET);
  });

  it('порожній/некоректний -> null', () => {
    expect(parseOneCall({}, 'X', '2026-07-01')).toBeNull();
    expect(parseOneCall({ current: {} }, 'X', '2026-07-01')).toBeNull();
  });
});

describe('weather-core — emojiFor/adviceFor/mergeAqi/COLD_THRESHOLD_C', () => {
  it('emojiFor мапить коди OpenWeather', () => {
    expect(emojiFor(200)).toBe('⛈');
    expect(emojiFor(500)).toBe('🌧');
    expect(emojiFor(800)).toBe('☀️');
    expect(emojiFor(802)).toBe('⛅');
    expect(emojiFor(803)).toBe('☁️');
  });

  it('adviceFor — пороги, той самий текст, що оркестратор', () => {
    expect(adviceFor(-5)).toContain('Морозно');
    expect(adviceFor(5)).toContain('Прохолодно');
    expect(adviceFor(30)).toContain('Спекотно');
  });

  it('mergeAqi — 1..5 з Air Pollution, інакше undefined', () => {
    expect(mergeAqi({ list: [{ main: { aqi: 2 } }] })).toBe(2);
    expect(mergeAqi({ list: [{ main: { aqi: 9 } }] })).toBeUndefined();
    expect(mergeAqi({})).toBeUndefined();
  });

  it('COLD_THRESHOLD_C = 10 (той самий поріг, що оркестратор)', () => {
    expect(COLD_THRESHOLD_C).toBe(10);
  });
});
