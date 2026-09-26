// calendar (producer, §6). Події на сьогодні у блок брифінгу й у RunBus для
// today-консьюмера.
//
// ⚠️ GOOGLE CALENDAR ТУТ БІЛЬШЕ НЕ ЧИТАЄТЬСЯ (ADR-027, етап 7 редизайну).
// Знімок доби робить ядро (web/core/brief/calendar-snapshot.mjs) і кладе в
// KV `state.calendarToday`; брифінг лише читає його. Так GOOGLE_* зникають
// із GitHub Secrets - разом із доступом раннера Actions до календаря.
//
// Знімок ЗА ІНШУ ДАТУ ігнорується мовчки: вчорашні події, показані як
// сьогоднішні, гірші за відсутній блок - за ними власник планує день.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

export const CALENDAR_BUS_KEY = 'calendar.today';

export interface CalendarEvent {
  title: string;
  time: string | null; // "HH:MM" Київ, або null для подій на весь день
  // Зберігаються у snapshot лише для детермінованого пошуку перетинів у
  // ранковому decision layer; старий форматер читає й далі тільки time/title.
  startMs?: number | null;
  endMs?: number | null;
}

/** Ключ у блобі `state`, який пише ядро (web/core/brief/calendar-snapshot.mjs). */
export const CALENDAR_SNAPSHOT_KEY = 'calendarToday';

/** Форма знімка - рівно те, що читає цей модуль. */
export interface CalendarSnapshot {
  date?: string;
  ready?: boolean;
  events?: CalendarEvent[];
  updatedAt?: string;
}

/**
 * Події зі знімка, якщо він сьогоднішній і готовий; інакше null із
 * причиною - викликач вирішує, як про це сказати.
 */
export function eventsFromSnapshot(
  snapshot: CalendarSnapshot | undefined,
  todayKey: string,
): { events: CalendarEvent[] } | { skip: string } {
  if (!snapshot) return { skip: 'знімка календаря в стані немає' };
  if (snapshot.ready !== true) return { skip: 'знімок календаря не готовий (ядро не дочиталось)' };
  if (snapshot.date !== todayKey) {
    return { skip: `знімок календаря за ${snapshot.date ?? '?'}, а сьогодні ${todayKey}` };
  }
  return { events: Array.isArray(snapshot.events) ? snapshot.events : [] };
}

export function createCalendarModule(): Module<AppConfig> {
  return {
    id: 'calendar',
    kind: 'producer',
    enabled: (config) => config.modules.calendar.enabled,
    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const todayKey = ctx.clock.todayKey();
      const picked = eventsFromSnapshot(
        ctx.state.get<CalendarSnapshot>(CALENDAR_SNAPSHOT_KEY),
        todayKey,
      );
      if ('skip' in picked) {
        ctx.log.warn(`calendar пропущено: ${picked.skip}`);
        return null;
      }
      const events = picked.events;

      ctx.bus.set(CALENDAR_BUS_KEY, events); // для today-консьюмера навіть якщо порожньо
      if (events.length === 0) return null;

      const lines = events.map((e) => (e.time ? `${e.time} ${e.title}` : `увесь день: ${e.title}`));
      return {
        id: 'calendar',
        title: 'Сьогодні в календарі',
        icon: '📅',
        summary: lines.join('\n'),
        priority: 30,
      };
    },
  };
}
