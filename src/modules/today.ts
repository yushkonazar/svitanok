// today (consumer, §6). Синтез погоди + календаря одним людяним рядком «на
// сьогодні». Бере локації з config.locations і будує ТІ САМІ slug, що weather
// (RunBus не перелічує ключі, §6). Сам нічого не фетчить; деградує до наявного
// або null. Не дублює деталізацію блоку weather — це швидкий погляд (§9).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { slugFor, weatherBusKey, type WeatherToday } from './weather.js';
import { CALENDAR_BUS_KEY, type CalendarEvent } from './calendar.js';

function tempStr(w: WeatherToday): string {
  if (!Number.isFinite(w.tempC)) return `${w.name} —`;
  const sign = w.tempC > 0 ? '+' : '';
  return `${w.name} ${sign}${w.tempC}°`;
}

function eventsPhrase(events: CalendarEvent[]): string {
  if (events.length === 0) return '';
  const first = events.find((e) => e.time);
  const count =
    events.length === 1
      ? '1 подія'
      : events.length < 5
        ? `${events.length} події`
        : `${events.length} подій`;
  return first ? `${count}, перша о ${first.time}` : count;
}

export const todayModule: Module<AppConfig> = {
  id: 'today',
  kind: 'consumer',
  enabled: () => true, // синтез завжди активний; продукує null, якщо нема входів
  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const weathers: WeatherToday[] = ctx.config.locations
      .map((loc, i) => ctx.bus.get<WeatherToday>(weatherBusKey(slugFor(loc, i))))
      .filter((w): w is WeatherToday => Boolean(w));

    const events = ctx.bus.get<CalendarEvent[]>(CALENDAR_BUS_KEY) ?? [];

    if (weathers.length === 0 && events.length === 0) return null;

    const parts: string[] = [];
    if (weathers.length > 0) {
      const anyRain = weathers.some((w) => w.willRain);
      const anyCold = weathers.some((w) => w.willBeCold);
      const marks = `${anyRain ? ' ☔' : ''}${anyCold ? ' 🧥' : ''}`;
      parts.push(weathers.map(tempStr).join(', ') + marks);
    }
    const ev = eventsPhrase(events);
    if (ev) parts.push(ev);

    return {
      id: 'today',
      title: 'На сьогодні',
      icon: '🌅',
      summary: parts.join(' · '),
      priority: 20,
    };
  },
};
