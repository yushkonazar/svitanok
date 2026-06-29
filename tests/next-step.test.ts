import { describe, it, expect } from 'vitest';
import { nextStepModule, safeIndex } from '../src/modules/next-step.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('safeIndex — межі', () => {
  it('обгортає за модулем довжини', () => {
    expect(safeIndex(0, 3)).toBe(0);
    expect(safeIndex(3, 3)).toBe(0);
    expect(safeIndex(4, 3)).toBe(1);
  });
  it('безпечний для відʼємних/нецілих (зсунутий state)', () => {
    expect(safeIndex(-1, 3)).toBe(2);
    expect(safeIndex(2.9, 3)).toBe(2);
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

function ctx(steps: string[], state: StateStore): Ctx<AppConfig> {
  const noop = () => {};
  return {
    state,
    config: { modules: { nextStep: { enabled: true, steps } } } as AppConfig,
    clock: {
      todayKey: () => '2026-07-01',
      kyivHour: () => 8,
      now: () => new Date(),
      isSunday: () => false,
    },
    bus: { get: () => undefined, set: () => {} },
    log: { debug: noop, info: noop, warn: noop, error: noop },
    llm: {} as Ctx['llm'],
    fetcher: {} as Ctx['fetcher'],
  };
}

describe('next-step — ротація', () => {
  it('показує крок за індексом і просуває state', async () => {
    const state = memState({ nextStepIndex: 0 });
    const block = await nextStepModule.run(ctx(['A', 'B', 'C'], state));
    expect(block!.summary).toBe('A');
    expect(state.get('nextStepIndex')).toBe(1);
  });

  it('зсунутий індекс за межі -> обгортка (не падає)', async () => {
    const state = memState({ nextStepIndex: 7 });
    const block = await nextStepModule.run(ctx(['A', 'B', 'C'], state));
    expect(block!.summary).toBe('B'); // 7 % 3 = 1
  });

  it('логує показаний крок для weekly-review', async () => {
    const state = memState({ nextStepIndex: 0 });
    await nextStepModule.run(ctx(['A'], state));
    expect(state.get('nextStepLog')).toEqual([{ step: 'A', date: '2026-07-01' }]);
  });

  it('порожній список -> null', async () => {
    expect(await nextStepModule.run(ctx([], memState()))).toBeNull();
  });
});
