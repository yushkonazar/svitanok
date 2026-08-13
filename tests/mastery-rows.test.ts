import { describe, it, expect } from 'vitest';
import { masteryRows, remaining, weeksLeft, MIN_SEEN } from '../web/app/src/lib/mastery.ts';
import type { MasteryTopic } from '../web/app/src/api/schema.ts';

// Майстерність: «де діри».
//
// ⚠️ Головний ризик блоку — назвати відсутність даних поганою оцінкою. Тема,
// якої жодного разу не питали, має easePct=null; підставити туди нуль означало
// б поставити їй найгіршу можливу оцінку саме за те, що її не перевіряли. Тому
// такі теми йдуть ОКРЕМОЮ купою, а не нулем у спільному рейтингу.

const topic = (over: Partial<MasteryTopic> & { id: string }): MasteryTopic => ({
  title: over.id,
  done: 0,
  total: 10,
  seen: 0,
  weak: 0,
  easePct: null,
  ...over,
});

describe('masteryRows — дві купи, а не один рейтинг', () => {
  it('тема без питань іде в «не перевірено», а не нулем у рейтинг', () => {
    const { rated, unrated } = masteryRows([
      topic({ id: 'a', done: 10, total: 10, seen: 0, easePct: null }),
    ]);
    expect(rated).toEqual([]);
    expect(unrated.map((t) => t.id)).toEqual(['a']);
  });

  it(`менше ${MIN_SEEN} питань — теж «не перевірено»: одна відповідь важить 20+ пунктів`, () => {
    const { rated, unrated } = masteryRows([
      topic({ id: 'мало', seen: MIN_SEEN - 1, easePct: 0 }),
      topic({ id: 'досить', seen: MIN_SEEN, easePct: 50 }),
    ]);
    expect(unrated.map((t) => t.id)).toEqual(['мало']);
    expect(rated.map((r) => r.id)).toEqual(['досить']);
  });

  it('розрив = відмічено мінус дається; додатний — «ілюзія знання»', () => {
    const [row] = masteryRows([
      topic({ id: 'a', done: 8, total: 10, seen: 20, easePct: 30 }),
    ]).rated;
    expect(row!.donePct).toBe(80);
    expect(row!.gap).toBe(50);
  });

  it('відʼємний розрив теж буває: даються питання, а роадмеп не відмічений', () => {
    const [row] = masteryRows([
      topic({ id: 'a', done: 1, total: 10, seen: 20, easePct: 90 }),
    ]).rated;
    expect(row!.gap).toBe(-80);
  });

  it('рейтинг веде НАЙБІЛЬШИЙ розрив — саме він і є інсайтом', () => {
    const { rated } = masteryRows([
      topic({ id: 'рівно', done: 5, total: 10, seen: 20, easePct: 50 }),
      topic({ id: 'ілюзія', done: 10, total: 10, seen: 20, easePct: 20 }),
      topic({ id: 'інтуїція', done: 0, total: 10, seen: 20, easePct: 90 }),
    ]);
    expect(rated.map((r) => r.id)).toEqual(['ілюзія', 'рівно', 'інтуїція']);
  });

  it('за однакового розриву вище той, де більше пройдено', () => {
    const { rated } = masteryRows([
      topic({ id: 'менше', done: 2, total: 10, seen: 20, easePct: 20 }),
      topic({ id: 'більше', done: 6, total: 10, seen: 20, easePct: 60 }),
    ]);
    expect(rated.map((r) => r.id)).toEqual(['більше', 'менше']);
  });

  it('неперевірені сортуються за прогресом: їх найдоречніше питати першими', () => {
    const { unrated } = masteryRows([
      topic({ id: 'порожня', done: 0, total: 10 }),
      topic({ id: 'майже', done: 9, total: 10 }),
    ]);
    expect(unrated.map((t) => t.id)).toEqual(['майже', 'порожня']);
  });

  it('тема без підпунктів не ділить на нуль', () => {
    const [row] = masteryRows([topic({ id: 'a', total: 0, seen: 10, easePct: 50 })]).rated;
    expect(row!.donePct).toBe(0);
  });

  it('порожній вхід — порожні купи, не виняток', () => {
    expect(masteryRows([])).toEqual({ rated: [], unrated: [] });
  });
});

describe('remaining / weeksLeft — темп і скільки лишилось', () => {
  const weeks = (counts: number[]) => counts.map((count, i) => ({ week: `w${i}`, count }));

  it('лишилось = сума незакритих підпунктів', () => {
    expect(
      remaining([topic({ id: 'a', done: 3, total: 10 }), topic({ id: 'b', done: 4, total: 4 })]),
    ).toBe(7);
  });

  it('перевиконання не дає відʼємного залишку', () => {
    expect(remaining([topic({ id: 'a', done: 12, total: 10 })])).toBe(0);
  });

  it('прогноз за темпом ОСТАННІХ тижнів, а не за всією історією', () => {
    // Давній ривок (по 10) не має тягнути оцінку: рахуємо хвіст.
    expect(weeksLeft(weeks([10, 10, 10, 10, 1, 1, 1, 1]), 20, 4)).toBe(20);
  });

  it('темп нуль -> null, а не «∞ тижнів»', () => {
    expect(weeksLeft(weeks([0, 0, 0, 0]), 20)).toBeNull();
  });

  it('нічого не лишилось -> прогнозу немає', () => {
    expect(weeksLeft(weeks([2, 2, 2, 2]), 0)).toBeNull();
  });

  it('порожній ряд тижнів -> null', () => {
    expect(weeksLeft([], 20)).toBeNull();
  });

  it('округлення ВГОРУ: півтора тижня — це два', () => {
    expect(weeksLeft(weeks([2, 2, 2, 2]), 3)).toBe(2);
  });
});
