// today (consumer, §6). Синтез погоди + календаря одним людяним рядком «на
// сьогодні». Бере локації з config.locations і будує ТІ САМІ slug, що weather
// (RunBus не перелічує ключі, §6). Сам нічого не фетчить; деградує до наявного
// або null. Не дублює деталізацію блоку weather — це швидкий погляд (§9).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import { slugFor, weatherBusKey, type WeatherToday } from './weather.js';
import { CALENDAR_BUS_KEY, type CalendarEvent } from './calendar.js';

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${n}°`;
}

function describeTemp(maxC: number): string {
  if (maxC >= 30) return 'спекотно';
  if (maxC >= 20) return 'тепло';
  if (maxC >= 10) return 'прохолодно';
  return 'холодно';
}

/**
 * Якісний синтез погоди БЕЗ дублювання блоку «Погода»: опис + одна температура
 * (або діапазон по локаціях) + мітки дії. Деталь по локаціях лишається в weather.
 */
function weatherSynth(weathers: WeatherToday[]): string {
  const temps = weathers.map((w) => w.tempC).filter((t) => Number.isFinite(t));
  const anyRain = weathers.some((w) => w.willRain);
  const anyCold = weathers.some((w) => w.willBeCold);
  const marks = `${anyRain ? ' ☔' : ''}${anyCold ? ' 🧥' : ''}`;
  if (temps.length === 0) return `погода${marks}`.trim();
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const tempPart = min === max ? signed(max) : `${signed(min)}…${signed(max)}`;
  return `${describeTemp(max)} ${tempPart}${marks}`;
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
    if (weathers.length > 0) parts.push(weatherSynth(weathers));
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
