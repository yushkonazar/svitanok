import { describe, it, expect, vi } from 'vitest';
import { parseEvents, createOnThisDayModule } from '../src/modules/onthisday.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('onthisday — parseEvents', () => {
  it('сортує новіші перші, обрізає до limit, тримить', () => {
    const ev = parseEvents(
      {
        events: [
          { year: 1991, text: ' A ' },
          { year: 2022, text: 'B' },
          { year: 2000, text: 'C' },
        ],
      },
      2,
    );
    expect(ev).toEqual([
      { year: 2022, text: 'B' },
      { year: 2000, text: 'C' },
    ]);
  });
  it('некоректне -> []', () => {
    expect(parseEvents('нема', 4)).toEqual([]);
    expect(parseEvents({ events: [{ text: 'без року' }] }, 4)).toEqual([]);
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
    expect(block!.inMessage).toBe(false);
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
