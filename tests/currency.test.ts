import { describe, it, expect, vi } from 'vitest';
import { pickRates, createCurrencyModule } from '../src/modules/currency.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('currency — pickRates', () => {
  it('бере USD/EUR, округлює до копійок', () => {
    expect(
      pickRates([
        { cc: 'USD', rate: 44.7917 },
        { cc: 'EUR', rate: 51.0334 },
        { cc: 'PLN', rate: 12 },
      ]),
    ).toEqual({ usd: 44.79, eur: 51.03 });
  });
  it('немає USD/EUR -> null', () => {
    expect(pickRates([{ cc: 'PLN', rate: 12 }])).toBeNull();
    expect(pickRates('нема')).toBeNull();
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
    config: { modules: { currency: { enabled: true } } } as unknown as AppConfig,
    state: {} as Ctx['state'],
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  }) as Ctx<AppConfig>;

describe('currency — модуль', () => {
  it('повертає блок inMessage:false з курсом', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { cc: 'USD', rate: 44 },
            { cc: 'EUR', rate: 51 },
          ]),
          {
            status: 200,
          },
        ),
    );
    const mod = createCurrencyModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const block = await mod.run(ctx());
    expect(block!.inMessage).toBe(false);
    expect(block!.summary).toContain('USD 44');
    expect(block!.data).toEqual({ usd: 44, eur: 51 });
  });

  it('HTTP-помилка -> null', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 500 }));
    const mod = createCurrencyModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await mod.run(ctx())).toBeNull();
  });
});
