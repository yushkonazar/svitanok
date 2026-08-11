import { describe, it, expect, vi } from 'vitest';
import { pickRates, createCurrencyModule } from '../src/modules/currency.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('currency — pickRates', () => {
  it('бере USD/EUR (обов), PLN/GBP (опц), округлює до копійок', () => {
    expect(
      pickRates([
        { cc: 'USD', rate: 44.7917 },
        { cc: 'EUR', rate: 51.0334 },
        { cc: 'PLN', rate: 12.005 },
        { cc: 'GBP', rate: 59.4 },
      ]),
    ).toEqual({ usd: 44.79, eur: 51.03, pln: 12.01, gbp: 59.4 });
  });
  it('немає USD/EUR -> null; PLN/GBP опційні', () => {
    expect(pickRates([{ cc: 'PLN', rate: 12 }])).toBeNull();
    expect(pickRates('нема')).toBeNull();
    expect(
      pickRates([
        { cc: 'USD', rate: 44 },
        { cc: 'EUR', rate: 51 },
      ]),
    ).toEqual({
      usd: 44,
      eur: 51,
    });
  });
});

const noop = () => {};
function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}
const ctx = (state: StateStore = memState()): Ctx<AppConfig> =>
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
    state,
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  }) as Ctx<AppConfig>;

const nbu = (arr: unknown) => vi.fn(async () => new Response(JSON.stringify(arr), { status: 200 }));

describe('currency — модуль', () => {
  it('повертає блок з курсом + історією', async () => {
    const fetchImpl = nbu([
      { cc: 'USD', rate: 44 },
      { cc: 'EUR', rate: 51 },
    ]);
    const mod = createCurrencyModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const block = await mod.run(ctx());
    expect(block!.summary).toContain('USD 44');
    const d = block!.data as Record<string, unknown>;
    expect(d.usd).toBe(44);
    expect(d.eur).toBe(51);
    expect(d.usdHistory).toEqual([44]); // перший день історії
    expect(d.plnHistory).toEqual([]); // PLN відсутній -> порожньо
  });

  it('історія накопичується в стані (дедуп за датою)', async () => {
    const state = memState({
      currencyHistory: [{ date: '2026-06-29', usd: 40, eur: 48 }],
    });
    const fetchImpl = nbu([
      { cc: 'USD', rate: 44 },
      { cc: 'EUR', rate: 51 },
      { cc: 'PLN', rate: 12 },
    ]);
    const mod = createCurrencyModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const block = await mod.run(ctx(state));
    const d = block!.data as Record<string, unknown>;
    expect(d.usdHistory).toEqual([40, 44]); // вчора + сьогодні
    expect(d.pln).toBe(12);
    // повторний запуск того ж дня не дублює
    await mod.run(ctx(state));
    expect((state.get('currencyHistory') as unknown[]).length).toBe(2);
  });

  it('HTTP-помилка -> null', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 500 }));
    const mod = createCurrencyModule({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await mod.run(ctx())).toBeNull();
  });
});
