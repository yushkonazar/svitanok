import { describe, it, expect } from 'vitest';
import { todayModule } from '../src/modules/today.js';
import { weatherBusKey, slugFor, type WeatherToday } from '../src/modules/weather.js';
import { CALENDAR_BUS_KEY } from '../src/modules/calendar.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, RunBus } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

const locations = [
  { lat: 49.8, lon: 24.0, name: 'Львів' },
  { lat: 51.1, lon: 26.4, name: 'Немовичі' },
];

function ctxWith(setup: (bus: RunBus) => void): Ctx<AppConfig> {
  const bus = createRunBus();
  setup(bus);
  const noop = () => {};
  return {
    bus,
    config: { locations } as AppConfig,
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    state: {} as Ctx['state'],
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

const w = (name: string, tempC: number, willRain = false, willBeCold = false): WeatherToday => ({
  name,
  tempC,
  condition: 'x',
  willRain,
  willBeCold,
  popPercent: willRain ? 60 : 0,
});

describe('today — синтез', () => {
  it('зводить локації у якісний рядок (без дублювання блоку Погода) + події', async () => {
    const ctx = ctxWith((bus) => {
      bus.set(weatherBusKey(slugFor(locations[0]!, 0)), w('Львів', 12, true));
      bus.set(weatherBusKey(slugFor(locations[1]!, 1)), w('Немовичі', 9));
      bus.set(CALENDAR_BUS_KEY, [{ title: 'Стендап', time: '10:00' }]);
    });
    const block = await todayModule.run(ctx);
    // Синтез: діапазон по локаціях, опис, мітка дощу — БЕЗ переліку «Львів +12°».
    expect(block!.summary).toContain('+9°…+12°');
    expect(block!.summary).toContain('прохолодно');
    expect(block!.summary).not.toContain('Львів'); // деталь — у блоці weather
    expect(block!.summary).toContain('☔');
    expect(block!.summary).toContain('перша о 10:00');
    expect(block!.priority).toBe(20);
  });

  it('лише погода (календар порожній) — деградує', async () => {
    const ctx = ctxWith((bus) => {
      bus.set(weatherBusKey(slugFor(locations[0]!, 0)), w('Львів', 5, false, true));
    });
    const block = await todayModule.run(ctx);
    expect(block!.summary).toContain('+5°');
    expect(block!.summary).toContain('холодно');
    expect(block!.summary).toContain('🧥');
  });

  it('лише календар (погода впала) — деградує', async () => {
    const ctx = ctxWith((bus) => {
      bus.set(CALENDAR_BUS_KEY, [{ title: 'Дзвінок', time: null }]);
    });
    const block = await todayModule.run(ctx);
    expect(block).not.toBeNull();
    expect(block!.summary).toContain('1 подія');
  });

  it('нема входів — null', async () => {
    const block = await todayModule.run(ctxWith(() => {}));
    expect(block).toBeNull();
  });
});
