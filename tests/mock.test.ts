import { describe, it, expect, vi } from 'vitest';
import { mockModule, buildMockPrompt } from '../src/modules/mock.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('mock — buildMockPrompt', () => {
  it('містить профіль і кількість', () => {
    const p = buildMockPrompt(15, 'Junior Full Stack');
    expect(p).toContain('15');
    expect(p).toContain('Junior Full Stack');
  });
});

function memState(initial: Record<string, unknown> = {}): StateStore {
  const data = { ...initial };
  return {
    get: <T>(k: string) => data[k] as T | undefined,
    set: <T>(k: string, v: T) => void (data[k] = v),
    prune: () => {},
    flush: async () => {},
  };
}

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
      modules: { mock: { enabled: true, batchSize: 3, profile: 'Junior FS' } },
    } as unknown as AppConfig,
    state: over.state ?? memState(),
    llm: over.llm ?? { complete: async () => '[]' },
    fetcher: {} as Ctx['fetcher'],
  };
}

describe('mock — батч-кеш', () => {
  it('кеш порожній -> один виклик, віддає перше питання, решта в кеш', async () => {
    const llm = { complete: vi.fn(async () => '["Що таке замикання?","Подія?","REST?"]') };
    const state = memState();
    const block = await mockModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Що таке замикання?');
    expect(block!.title).toBe('Питання дня');
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(state.get('mockCache')).toEqual(['Подія?', 'REST?']);
  });

  it('кеш не порожній -> без LLM', async () => {
    const llm = { complete: vi.fn() };
    const state = memState({ mockCache: ['Готове питання'] });
    const block = await mockModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Готове питання');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('LLM кинув -> null', async () => {
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('таймаут');
      }),
    };
    expect(await mockModule.run(makeCtx({ state: memState(), llm }))).toBeNull();
  });
});
