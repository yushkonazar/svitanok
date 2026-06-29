import { describe, it, expect, vi } from 'vitest';
import {
  kyivDayBoundsUtc,
  parseEvents,
  createCalendarModule,
  CALENDAR_BUS_KEY,
} from '../src/modules/calendar.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('kyivDayBoundsUtc — DST межі дня (§19.11)', () => {
  it('літо (Київ +3): межі зсунуті на 3 години', () => {
    const { timeMin, timeMax } = kyivDayBoundsUtc('2026-07-01');
    expect(timeMin).toBe('2026-06-30T21:00:00.000Z'); // 00:00 Kyiv = 21:00 UTC попереднього дня
    expect(timeMax).toBe('2026-07-01T21:00:00.000Z');
  });

  it('зима (Київ +2): межі зсунуті на 2 години (НЕ хардкод +03:00)', () => {
    const { timeMin, timeMax } = kyivDayBoundsUtc('2026-01-01');
    expect(timeMin).toBe('2025-12-31T22:00:00.000Z');
    expect(timeMax).toBe('2026-01-01T22:00:00.000Z');
  });
});

describe('parseEvents', () => {
  it('подія з часом -> HH:MM Київ; без назви -> заглушка', () => {
    const evs = parseEvents({
      items: [
        { summary: 'Зустріч', start: { dateTime: '2026-07-01T09:30:00Z' } }, // 12:30 Kyiv
        { start: { date: '2026-07-01' } },
      ],
    });
    expect(evs[0]).toEqual({ title: 'Зустріч', time: '12:30' });
    expect(evs[1]).toEqual({ title: '(без назви)', time: null });
  });

  it('некоректний json -> []', () => {
    expect(parseEvents({})).toEqual([]);
  });
});

function makeCtx(): Ctx<AppConfig> {
  const noop = () => {};
  return {
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: {} as AppConfig,
    state: {} as Ctx['state'],
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

const creds = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};

describe('calendar module', () => {
  it('повертає Block з подіями і пише calendar.today у bus', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          items: [{ summary: 'Стендап', start: { dateTime: '2026-07-01T07:00:00Z' } }],
        }),
        { status: 200 },
      );
    });
    const mod = createCalendarModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: creds,
    });
    const ctx = makeCtx();
    const block = await mod.run(ctx);
    expect(block!.summary).toContain('Стендап');
    expect(ctx.bus.get(CALENDAR_BUS_KEY)).toHaveLength(1);
  });

  it('401/invalid_grant на token -> null (не валить)', async () => {
    const fetchImpl = vi.fn(async () => new Response('invalid_grant', { status: 400 }));
    const mod = createCalendarModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: creds,
    });
    expect(await mod.run(makeCtx())).toBeNull();
  });

  it('без GOOGLE_* секретів -> null', async () => {
    const mod = createCalendarModule({ fetchImpl: vi.fn() as unknown as typeof fetch, env: {} });
    expect(await mod.run(makeCtx())).toBeNull();
  });

  it('порожній календар -> null, але bus.calendar.today = []', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/token')
        ? new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 })
        : new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const mod = createCalendarModule({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: creds,
    });
    const ctx = makeCtx();
    expect(await mod.run(ctx)).toBeNull();
    expect(ctx.bus.get(CALENDAR_BUS_KEY)).toEqual([]);
  });
});
