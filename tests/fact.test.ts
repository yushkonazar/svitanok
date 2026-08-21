import { describe, it, expect, vi } from 'vitest';
import { parseFacts, factModule } from '../src/modules/fact.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';
import { memState } from './helpers/state.js';

describe('fact — parseFacts', () => {
  it('витягує масив рядків із прози навколо', () => {
    expect(parseFacts('Ось: ["A","B"] — все')).toEqual(['A', 'B']);
  });
  it('фільтрує не-рядки й порожні, тримить пробіли', () => {
    expect(parseFacts('[" A ", 1, "", "B"]')).toEqual(['A', 'B']);
  });
  it('малформат -> []', () => {
    expect(parseFacts('нема json')).toEqual([]);
    expect(parseFacts('[зламано')).toEqual([]);
  });
});

function makeCtx(over: { state?: StateStore; llm?: Ctx['llm'] }): Ctx<AppConfig> {
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
    config: {
      llm: { timeoutMs: 1000 },
      modules: { fact: { enabled: true, batchSize: 3 } },
    } as unknown as AppConfig,
    state: over.state ?? memState(),
    llm: over.llm ?? { complete: async () => '[]' },
    fetcher: {} as Ctx['fetcher'],
  };
}

describe('fact — батч-кеш', () => {
  it('кеш порожній -> один LLM-виклик наповнює, віддає перший, решта в кеш', async () => {
    const llm = { complete: vi.fn(async () => '["Факт1","Факт2","Факт3"]') };
    const state = memState();
    const block = await factModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Факт1');
    expect(block!.title).toBe('Факт дня');
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(state.get('factCache')).toEqual(['Факт2', 'Факт3']);
  });

  it('кеш не порожній -> БЕЗ виклику LLM', async () => {
    const llm = { complete: vi.fn() };
    const state = memState({ factCache: ['Готовий факт', 'Ще'] });
    const block = await factModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Готовий факт');
    expect(llm.complete).not.toHaveBeenCalled();
    expect(state.get('factCache')).toEqual(['Ще']);
  });

  it('LLM кинув -> null', async () => {
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('таймаут');
      }),
    };
    expect(await factModule.run(makeCtx({ state: memState(), llm }))).toBeNull();
  });

  it('LLM повернув сміття -> null', async () => {
    const llm = { complete: vi.fn(async () => 'без жодного JSON') };
    expect(await factModule.run(makeCtx({ state: memState(), llm }))).toBeNull();
  });
});
