import { describe, it, expect, vi } from 'vitest';
import { parseEvents, selectHistoric, createOnThisDayModule } from '../src/modules/onthisday.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('onthisday — parseEvents', () => {
  it('валідує й тримить, порядок не важливий (сортує/відбирає selectHistoric)', () => {
    const ev = parseEvents({
      events: [
        { year: 1991, text: ' A ' },
        { year: 2022, text: 'B' },
      ],
    });
    expect(ev).toEqual([
      { year: 1991, text: 'A' },
      { year: 2022, text: 'B' },
    ]);
  });
  it('некоректне -> []', () => {
    expect(parseEvents('нема')).toEqual([]);
    expect(parseEvents({ events: [{ text: 'без року' }] })).toEqual([]);
  });

  it('витягує url статті з pages[] (D3, desktop; фолбек mobile)', () => {
    const ev = parseEvents({
      events: [
        {
          year: 1991,
          text: 'A',
          pages: [{ content_urls: { desktop: { page: 'https://uk.wikipedia.org/wiki/A' } } }],
        },
        {
          year: 2000,
          text: 'B',
          pages: [{ content_urls: { mobile: { page: 'https://uk.m.wikipedia.org/wiki/B' } } }],
        },
        { year: 2001, text: 'C' }, // без pages -> без url
        { year: 2002, text: 'D', pages: [{ content_urls: { desktop: { page: 42 } } }] }, // не рядок
      ],
    });
    expect(ev[0]).toEqual({ year: 1991, text: 'A', url: 'https://uk.wikipedia.org/wiki/A' });
    expect(ev[1]?.url).toBe('https://uk.m.wikipedia.org/wiki/B');
    expect(ev[2]?.url).toBeUndefined();
    expect(ev[3]?.url).toBeUndefined();
  });
});

describe('onthisday — selectHistoric (стратифікація епох)', () => {
  const ev = (year: number, text = `подія ${year}`) => ({ year, text });

  it('резервує до 3 стародавніх (<1900, найстаріші перші) на початку списку', () => {
    const events = [ev(1500), ev(1200), ev(1800), ev(600), ev(2020), ev(2021), ev(2022), ev(1950)];
    const picked = selectHistoric(events, 10);
    // 3 найстаріші з <1900, за зростанням року.
    expect(picked.slice(0, 3)).toEqual([ev(600), ev(1200), ev(1500)]);
  });

  it('резервує до 3 подій XX ст. (новіші перші) одразу після стародавніх', () => {
    const events = [ev(600), ev(1950), ev(1980), ev(1999), ev(1960), ev(2022)];
    const picked = selectHistoric(events, 10);
    expect(picked[0]).toEqual(ev(600)); // 1 стародавня
    expect(picked.slice(1, 4)).toEqual([ev(1999), ev(1980), ev(1960)]); // топ-3 XX ст. новіші перші
  });

  it('XXI ст. заповнює залишок бюджету (новіші перші)', () => {
    const events = [ev(2020), ev(2010), ev(2022), ev(2000)];
    const picked = selectHistoric(events, 3);
    expect(picked).toEqual([ev(2022), ev(2020), ev(2010)]);
  });

  it('без стародавніх/XX ст. — поведінка як проста сортовка «новіші перші» (регресія)', () => {
    const events = [ev(2019), ev(2022), ev(2005)];
    const picked = selectHistoric(events, 10);
    expect(picked).toEqual([ev(2022), ev(2019), ev(2005)]);
  });

  it('лише 1 стародавня подія — не доповнюється, бюджет перепадає далі', () => {
    const events = [ev(1500), ev(1980), ev(1990), ev(1970), ev(1960), ev(2020)];
    const picked = selectHistoric(events, 5);
    // 1 стародавня + 3 XX ст. (найновіші) + 1 XXI ст. = 5, без порожніх слотів.
    expect(picked).toEqual([ev(1500), ev(1990), ev(1980), ev(1970), ev(2020)]);
  });

  it('менше подій, ніж limit — повертає скільки є, без дублів/паддінгу', () => {
    const events = [ev(1500), ev(2020)];
    expect(selectHistoric(events, 10)).toEqual([ev(1500), ev(2020)]);
  });

  it('rollover: надлишок XX ст. понад квоту добирається, коли XXI ст. закоротке', () => {
    // 2 стародавні (< квоти 3) + 5 подій XX ст. (> квоти 3) + 3 XXI ст.
    // Наївний однопрохідний розподіл дав би лише 8 (2+3+3), хоча сирих 10 і
    // limit=10 — решта 2 з XX ст. понад квоту мають добратись у кінець.
    const events = [
      ev(1789),
      ev(1863),
      ev(1945),
      ev(1961),
      ev(1969),
      ev(1990),
      ev(1996),
      ev(2004),
      ev(2010),
      ev(2022),
    ];
    const picked = selectHistoric(events, 10);
    expect(picked).toEqual([
      ev(1789),
      ev(1863), // стародавні (2, повністю — квота 3 не вичерпана)
      ev(1996),
      ev(1990),
      ev(1969), // топ-3 XX ст. за квотою (новіші перші)
      ev(2022),
      ev(2010),
      ev(2004), // усі XXI ст. (3, влізли в бюджет)
      ev(1961),
      ev(1945), // rollover: залишок XX ст. понад квоту добирає бюджет до limit=10
    ]);
  });

  it('порожній вхід або limit=0 -> []', () => {
    expect(selectHistoric([], 10)).toEqual([]);
    expect(selectHistoric([ev(2020)], 0)).toEqual([]);
  });
});

const noop = () => {};
const ctx = (): Ctx<AppConfig> =>
  ({
    bus: createRunBus(),
    clock: {
      todayKey: () => '2026-06-30',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    config: { modules: { onthisday: { enabled: true } } } as unknown as AppConfig,
    state: {} as Ctx['state'],
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  }) as Ctx<AppConfig>;

describe('onthisday — модуль', () => {
  it('повертає блок inMessage:false з подіями; URL за MM/DD', async () => {
    const fetchImpl = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ events: [{ year: 2022, text: 'Подія' }] }), { status: 200 }),
    );
    const mod = createOnThisDayModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const block = await mod.run(ctx());
    expect(block!.summary).toContain('2022: Подія');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/events/06/30'); // MM/DD з todayKey
  });

  it('порожні події -> null', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ events: [] }), { status: 200 }),
    );
    const mod = createOnThisDayModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await mod.run(ctx())).toBeNull();
  });
});
