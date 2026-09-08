// Блок «Сьогодні в календарі» після ADR-027 (етап 7 PR-2): модуль брифінгу
// більше не ходить у Google, а читає знімок доби, який поклало ядро в KV
// `state.calendarToday`. Межі київської доби й розбір відповіді Google
// переїхали в ядро - їх перевіряє tests/calendar-core.test.ts.

import { describe, it, expect } from 'vitest';
import {
  createCalendarModule,
  eventsFromSnapshot,
  CALENDAR_BUS_KEY,
  CALENDAR_SNAPSHOT_KEY,
  type CalendarSnapshot,
} from '../src/modules/calendar.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

const TODAY = '2026-07-01';

function makeCtx(snapshot?: CalendarSnapshot): { ctx: Ctx<AppConfig>; warns: string[] } {
  const noop = () => {};
  const warns: string[] = [];
  const store: Record<string, unknown> = {};
  if (snapshot) store[CALENDAR_SNAPSHOT_KEY] = snapshot;
  const ctx: Ctx<AppConfig> = {
    bus: createRunBus(),
    clock: {
      todayKey: () => TODAY,
      kyivHour: () => 8,
      now: () => new Date(`${TODAY}T05:00:00Z`),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: (m: string) => void warns.push(m), error: noop },
    config: {} as AppConfig,
    state: {
      get: <T>(key: string) => store[key] as T | undefined,
      set: (key: string, value: unknown) => void (store[key] = value),
    } as unknown as Ctx['state'],
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
  return { ctx, warns };
}

describe('eventsFromSnapshot', () => {
  it('сьогоднішній готовий знімок - події', () => {
    const events = [{ title: 'Стендап', time: '10:00' }];
    expect(eventsFromSnapshot({ date: TODAY, ready: true, events }, TODAY)).toEqual({ events });
  });

  it('знімка немає - skip із причиною', () => {
    expect(eventsFromSnapshot(undefined, TODAY)).toEqual({
      skip: expect.stringContaining('немає'),
    });
  });

  it('ВЧОРАШНІЙ знімок не показується як сьогоднішній', () => {
    const stale = { date: '2026-06-30', ready: true, events: [{ title: 'Вчора', time: '09:00' }] };
    const got = eventsFromSnapshot(stale, TODAY);
    expect(got).toEqual({ skip: expect.stringContaining('2026-06-30') });
  });

  it('незавершений знімок (ядро не дочиталось) - skip, а не порожній день', () => {
    expect(eventsFromSnapshot({ date: TODAY, ready: false, events: [] }, TODAY)).toEqual({
      skip: expect.stringContaining('не готовий'),
    });
  });
});

describe('calendar module', () => {
  it('повертає Block з подіями і пише calendar.today у bus', async () => {
    const { ctx } = makeCtx({
      date: TODAY,
      ready: true,
      events: [{ title: 'Стендап', time: '10:00' }],
    });
    const block = await createCalendarModule().run(ctx);
    expect(block!.summary).toContain('Стендап');
    expect(ctx.bus.get(CALENDAR_BUS_KEY)).toHaveLength(1);
  });

  it('подія на весь день - рядок «увесь день: …»', async () => {
    const { ctx } = makeCtx({
      date: TODAY,
      ready: true,
      events: [{ title: 'Відпустка', time: null }],
    });
    expect((await createCalendarModule().run(ctx))!.summary).toBe('увесь день: Відпустка');
  });

  it('знімка немає -> null і попередження в лог (мовчазної деградації немає)', async () => {
    const { ctx, warns } = makeCtx();
    expect(await createCalendarModule().run(ctx)).toBeNull();
    expect(warns.join(' ')).toContain('calendar пропущено');
  });

  it('вчорашній знімок -> null; bus теж не заповнюється чужим днем', async () => {
    const { ctx } = makeCtx({
      date: '2026-06-30',
      ready: true,
      events: [{ title: 'Вчора', time: '09:00' }],
    });
    expect(await createCalendarModule().run(ctx)).toBeNull();
    expect(ctx.bus.get(CALENDAR_BUS_KEY)).toBeUndefined();
  });

  it('порожній календар -> null, але bus.calendar.today = []', async () => {
    const { ctx } = makeCtx({ date: TODAY, ready: true, events: [] });
    expect(await createCalendarModule().run(ctx)).toBeNull();
    expect(ctx.bus.get(CALENDAR_BUS_KEY)).toEqual([]);
  });
});
