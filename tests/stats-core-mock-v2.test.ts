import { describe, it, expect } from 'vitest';
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';

// «Питання дня» v2 (роадмеп v3, F4): оцінка привʼязана до ПИТАННЯ (qId), а не
// до дня. Головне, що це чинить: дедуп (повторний тап/ретрай більше не рахує
// тему двічі) і збереження обраного варіанта між перезавантаженнями.

interface Store {
  mockTopics: Record<string, { seen: number; weak: number } | undefined>;
  mockRated: Record<string, string | undefined>;
  days: Record<string, { mock?: number } | undefined>;
}
interface Agg {
  mockRatedToday: boolean;
  mockRated: Record<string, string>;
  mock: { streak: number; weakTopics: Array<{ name: string; value: number }> };
}

const rate = (
  s: unknown,
  o: { qId?: string; topic?: string; rating?: unknown },
  day = '2026-07-07',
) => recordEvent(s, { type: 'mock_answer', ...o }, day) as Store;
const agg = (s: unknown, day: string) => aggregateStats(s, day) as Agg;

describe('mock v2 — оцінка по питанню (дедуп)', () => {
  it('повторна оцінка ТОГО САМОГО питання не рахує тему двічі', () => {
    // Доти recordEvent не мав дедупу взагалі: кожен POST знову бампав seen/weak,
    // тож подвійний тап або мережевий ретрай тихо кривили ваги генератора.
    let s = rate(emptyStore(), { qId: 'q1', topic: 'Алгоритми', rating: 'hard' });
    s = rate(s, { qId: 'q1', topic: 'Алгоритми', rating: 'hard' });
    s = rate(s, { qId: 'q1', topic: 'Алгоритми', rating: 'hard' });
    expect(s.mockTopics['Алгоритми']).toEqual({ seen: 1, weak: 1 });
    expect(s.days['2026-07-07']?.mock).toBe(1);
  });

  it('зміна думки переставляє weak, не додаючи seen', () => {
    let s = rate(emptyStore(), { qId: 'q1', topic: 'Мова', rating: 'hard' });
    expect(s.mockTopics['Мова']).toEqual({ seen: 1, weak: 1 });
    s = rate(s, { qId: 'q1', topic: 'Мова', rating: 'easy' });
    expect(s.mockTopics['Мова']).toEqual({ seen: 1, weak: 0 });
    s = rate(s, { qId: 'q1', topic: 'Мова', rating: 'hard' });
    expect(s.mockTopics['Мова']).toEqual({ seen: 1, weak: 1 });
  });

  it('різні питання однієї теми рахуються окремо', () => {
    let s = rate(emptyStore(), { qId: 'q1', topic: 'HTTP', rating: 'hard' });
    s = rate(s, { qId: 'q2', topic: 'HTTP', rating: 'easy' });
    expect(s.mockTopics['HTTP']).toEqual({ seen: 2, weak: 1 });
  });

  it('weak не йде в мінус на битому сторі', () => {
    const broken = { mockTopics: { X: { seen: 1, weak: 0 } }, mockRated: { q1: 'hard' } };
    const s = rate(broken, { qId: 'q1', topic: 'X', rating: 'easy' });
    expect(s.mockTopics['X']).toEqual({ seen: 1, weak: 0 });
  });

  it('обрану оцінку видно в агрегаті — картка переживе перезавантаження', () => {
    const s = rate(emptyStore(), { qId: 'q1', topic: 'Мова', rating: 'easy' });
    expect(agg(s, '2026-07-07').mockRated['q1']).toBe('easy');
  });

  it('невалідний rating не рахується взагалі', () => {
    for (const bad of ['вгору', '', null, undefined, 1, {}]) {
      const s = rate(emptyStore(), { qId: 'q1', topic: 'Мова', rating: bad });
      expect(s.mockTopics['Мова']).toBeUndefined();
      expect(s.days['2026-07-07']).toBeUndefined();
      expect(s.mockRated).toEqual({});
    }
  });

  it('без qId (старий клієнт) поведінка лишається як була — рахує щоразу', () => {
    let s = rate(emptyStore(), { topic: 'Мова', rating: 'hard' });
    s = rate(s, { topic: 'Мова', rating: 'hard' });
    expect(s.mockTopics['Мова']).toEqual({ seen: 2, weak: 2 });
  });

  it('журнал оцінок обмежений — блоб не росте роками', () => {
    let s: Store = emptyStore();
    for (let i = 0; i < 80; i++) s = rate(s, { qId: `q${i}`, topic: 'Мова', rating: 'easy' });
    const keys = Object.keys(s.mockRated);
    expect(keys.length).toBeLessThanOrEqual(60);
    expect(keys.at(-1)).toBe('q79'); // лишається ХВІСТ, найсвіжіші
    expect(s.mockRated['q0']).toBeUndefined();
  });
});

describe('mock v2 — стрік лишається ДЕННИМ', () => {
  it('стрік рахує дні практики, а не кількість тапів', () => {
    // Свідомо не змінюємо: «оцінив питання» — про питання, а стрік — про звичку.
    let s = rate(emptyStore(), { qId: 'a', topic: 'Мова', rating: 'easy' }, '2026-07-06');
    s = rate(s, { qId: 'a2', topic: 'Мова', rating: 'easy' }, '2026-07-06'); // другий того ж дня
    s = rate(s, { qId: 'b', topic: 'Мова', rating: 'easy' }, '2026-07-07');
    expect(agg(s, '2026-07-07').mock.streak).toBe(2);
  });

  it('mockRatedToday лишається денним прапором', () => {
    const s = rate(emptyStore(), { qId: 'q1', topic: 'Мова', rating: 'easy' }, '2026-07-07');
    expect(agg(s, '2026-07-07').mockRatedToday).toBe(true);
    expect(agg(s, '2026-07-08').mockRatedToday).toBe(false);
  });

  it('повторна оцінка того ж питання не роздуває день (стрік чесний)', () => {
    let s = rate(emptyStore(), { qId: 'q1', topic: 'Мова', rating: 'easy' }, '2026-07-07');
    s = rate(s, { qId: 'q1', topic: 'Мова', rating: 'hard' }, '2026-07-07');
    expect(s.days['2026-07-07']?.mock).toBe(1);
  });
});
