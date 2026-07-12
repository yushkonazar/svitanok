import { describe, it, expect, vi } from 'vitest';
import {
  mockModule,
  buildMockPrompt,
  parseMockCache,
  updateMockWeight,
  sanitizeMasteryFocus,
  type MockWeights,
} from '../src/modules/mock.js';
import { createRunBus } from '../src/core/bus.js';
import type { Ctx, StateStore } from '../src/core/types.js';
import type { AppConfig } from '../src/core/config.js';

describe('mock — buildMockPrompt', () => {
  it('містить профіль і кількість', () => {
    const p = buildMockPrompt(15, 'Junior Full Stack');
    expect(p).toContain('15');
    expect(p).toContain('Junior Full Stack');
  });

  it('без слабких тем (усі ваги <=1.0) -> без підказки', () => {
    const p = buildMockPrompt(5, 'Junior', { Алгоритми: 1.0, HTTP: 0.5 });
    expect(p).not.toContain('слабким темам');
  });

  it('зі слабкими темами (вага >1.0) -> підказка, сортована спадаюче', () => {
    const p = buildMockPrompt(5, 'Junior', { HTTP: 1.4, Алгоритми: 1.8, Мова: 1.0 });
    expect(p).toContain('слабким темам кандидата: Алгоритми, HTTP');
    expect(p).not.toContain('Мова.');
  });
});

describe('mock — parseMockCache', () => {
  it('парсить topic; порожній/відсутній topic -> undefined', () => {
    const items = parseMockCache(
      '[{"q":"Q1","a":"A1","topic":"HTTP"},{"q":"Q2","a":"A2","topic":""},{"q":"Q3","a":"A3"}]',
    );
    expect(items).toEqual([
      { q: 'Q1', a: 'A1', topic: 'HTTP' },
      { q: 'Q2', a: 'A2', topic: undefined },
      { q: 'Q3', a: 'A3', topic: undefined },
    ]);
  });
});

describe('mock — updateMockWeight', () => {
  it('hard -> вага росте; easy -> спадає; clamp [0.5,2.0]', () => {
    let w: MockWeights = {};
    w = updateMockWeight(w, 'Алгоритми', 'hard');
    expect(w['Алгоритми']).toBeCloseTo(1.2);
    w = updateMockWeight(w, 'Алгоритми', 'easy');
    expect(w['Алгоритми']).toBeCloseTo(1.0);
    for (let i = 0; i < 20; i++) w = updateMockWeight(w, 'Алгоритми', 'easy');
    expect(w['Алгоритми']).toBe(0.5);
    for (let i = 0; i < 20; i++) w = updateMockWeight(w, 'Алгоритми', 'hard');
    expect(w['Алгоритми']).toBe(2.0);
  });

  it('порожня тема -> без змін', () => {
    const w: MockWeights = { HTTP: 1.0 };
    expect(updateMockWeight(w, '', 'hard')).toBe(w);
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
  it('кеш порожній -> один виклик; питання+відповідь+resourceUrl; решта в кеш', async () => {
    const llm = {
      complete: vi.fn(
        async () =>
          '[{"q":"Що таке замикання?","a":"Функція + її оточення."},{"q":"Подія?","a":"…"}]',
      ),
    };
    const state = memState();
    const block = await mockModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Що таке замикання?');
    const d = block!.data as { question: string; answer?: string; resourceUrl?: string };
    expect(d.answer).toBe('Функція + її оточення.');
    expect(d.resourceUrl).toContain('google.com/search');
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(state.get('mockCache')).toEqual([{ q: 'Подія?', a: '…' }]);
  });

  it('кеш не порожній -> без LLM', async () => {
    const llm = { complete: vi.fn() };
    const state = memState({ mockCache: [{ q: 'Готове питання', a: 'Відповідь' }] });
    const block = await mockModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Готове питання');
    expect((block!.data as { answer?: string }).answer).toBe('Відповідь');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('кеш без відповідей ({q,a:""} або string[]) регенерує через LLM', async () => {
    const llm = { complete: vi.fn(async () => '[{"q":"Нове","a":"Відповідь"}]') };
    const state = memState({ mockCache: [{ q: 'Старе', a: '' }, 'теж старе'] });
    const block = await mockModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Нове');
    expect((block!.data as { answer?: string }).answer).toBe('Відповідь');
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('LLM кинув -> null', async () => {
    const llm = {
      complete: vi.fn(async () => {
        throw new Error('таймаут');
      }),
    };
    expect(await mockModule.run(makeCtx({ state: memState(), llm }))).toBeNull();
  });

  it('topic з кешу потрапляє в data.topic', async () => {
    const state = memState({ mockCache: [{ q: 'Q', a: 'A', topic: 'HTTP' }] });
    const block = await mockModule.run(makeCtx({ state, llm: { complete: vi.fn() } }));
    expect((block!.data as { topic?: string }).topic).toBe('HTTP');
  });

  it('mockWeights зі стану потрапляють у промпт при регенерації (слабкі теми)', async () => {
    const llm = { complete: vi.fn(async () => '[{"q":"Q","a":"A","topic":"Алгоритми"}]') };
    const state = memState({ mockWeights: { Алгоритми: 1.6, HTTP: 1.0 } });
    await mockModule.run(makeCtx({ state, llm }));
    expect(llm.complete).toHaveBeenCalledWith(
      expect.stringContaining('слабким темам кандидата: Алгоритми'),
      expect.anything(),
    );
  });
});

describe('mock — masteryFocus («тема тижня», A4)', () => {
  it('sanitizeMasteryFocus: фільтрує теми поза словником; без валідних -> null', () => {
    expect(sanitizeMasteryFocus(null)).toBeNull();
    expect(sanitizeMasteryFocus('сміття')).toBeNull();
    // roadmap-only тема (tools/ecosystem) без mock-тем -> без зсуву батчу
    expect(sanitizeMasteryFocus({ title: '🛠 Git', mockTopics: [] })).toBeNull();
    expect(
      sanitizeMasteryFocus({ title: '⚛️ React', mockTopics: ['Фреймворк', 'Вигадана'] }),
    ).toMatchObject({ title: '⚛️ React', mockTopics: ['Фреймворк'] });
  });

  it('buildMockPrompt із фокусом містить тему тижня та її mock-теми', () => {
    const p = buildMockPrompt(5, 'Junior', undefined, {
      week: '2026-07-06',
      topicId: 'react',
      title: '⚛️ React',
      done: 3,
      total: 6,
      mockTopics: ['Фреймворк'],
    });
    expect(p).toContain('Тема тижня з навчального роадмепу: «⚛️ React»');
    expect(p).toContain('Фреймворк');
    // без фокуса — рядка нема
    expect(buildMockPrompt(5, 'Junior')).not.toContain('Тема тижня');
  });

  it('masteryFocus зі state потрапляє в промпт регенерації', async () => {
    const llm = { complete: vi.fn(async () => '[{"q":"Q","a":"A"}]') };
    const state = memState({
      masteryFocus: { title: '⚛️ React', mockTopics: ['Фреймворк'] },
    });
    await mockModule.run(makeCtx({ state, llm }));
    expect(llm.complete).toHaveBeenCalledWith(
      expect.stringContaining('Тема тижня'),
      expect.anything(),
    );
  });

  it('битий masteryFocus у state не ламає генерацію (без зсуву)', async () => {
    const llm = { complete: vi.fn(async () => '[{"q":"Q","a":"A"}]') };
    const state = memState({ masteryFocus: { broken: true } });
    const block = await mockModule.run(makeCtx({ state, llm }));
    expect(block!.summary).toBe('Q');
    expect(llm.complete).toHaveBeenCalledWith(
      expect.not.stringContaining('Тема тижня'),
      expect.anything(),
    );
  });
});
