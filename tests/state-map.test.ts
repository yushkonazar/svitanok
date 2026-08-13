import { describe, it, expect } from 'vitest';
import { readingsOf, gridOf, SLOT_FILTERS } from '../web/app/src/lib/stateMap.ts';
import type { CheckinRaw } from '../web/app/src/api/schema.ts';

// Карта станів — розбір гарячого вікна на зрізи «енергія×настрій».
//
// ⚠️ ГОЛОВНЕ, ЩО ТУТ ПЕРЕВІРЯЄТЬСЯ, — що слот НЕ губиться. Доти сітка зсипала
// ранок, день і вечір в одну купу, і «енергія 2 · настрій 2» вранці
// (недоспав) та ввечері (виснажився) ставали одним числом у клітинці. Це два
// різні явища з різними причинами, і саме слот робить звʼязок із причинами
// чесним: у ранковому записі лежить сон, у вечірньому — блокери.

const raw = (records: CheckinRaw['records']): CheckinRaw => ({
  days: 90,
  from: '2026-05-16',
  to: '2026-08-13',
  records,
});

describe('readingsOf — зрізи з гарячого вікна', () => {
  it('бере ОБИДВА виміри лише коли є обидва: пів-відповідь не зріз', () => {
    const r = raw({
      '2026-08-13': {
        morning: { energy: 4, mood: 5 },
        afternoon: { energy: 3 }, // настрою немає -> не зріз
        evening: { mood: 2 }, // енергії немає -> не зріз
      },
    });
    expect(readingsOf(r, 'all')).toEqual([
      { d: '2026-08-13', slot: 'morning', energy: 4, mood: 5 },
    ]);
  });

  it('слот їде разом зі зрізом — інакше причини нема до чого привʼязати', () => {
    const r = raw({
      '2026-08-13': {
        morning: { energy: 2, mood: 2 },
        evening: { energy: 2, mood: 2 },
      },
    });
    const all = readingsOf(r, 'all');
    expect(all.map((x) => x.slot)).toEqual(['morning', 'evening']);
    // Однакова пара чисел, РІЗНІ явища — і тепер їх видно окремо.
    expect(readingsOf(r, 'morning')).toHaveLength(1);
    expect(readingsOf(r, 'evening')).toHaveLength(1);
  });

  it('фільтр по слоту віддає лише свій слот', () => {
    const r = raw({
      '2026-08-13': {
        morning: { energy: 1, mood: 1 },
        afternoon: { energy: 3, mood: 3 },
        evening: { energy: 5, mood: 5 },
      },
    });
    expect(readingsOf(r, 'afternoon')).toEqual([
      { d: '2026-08-13', slot: 'afternoon', energy: 3, mood: 3 },
    ]);
  });

  it('зрізи впорядковані за датою — список дат у деталях має читатись', () => {
    const r = raw({
      '2026-08-13': { morning: { energy: 3, mood: 3 } },
      '2026-06-01': { morning: { energy: 3, mood: 3 } },
      '2026-07-04': { morning: { energy: 3, mood: 3 } },
    });
    expect(readingsOf(r, 'all').map((x) => x.d)).toEqual([
      '2026-06-01',
      '2026-07-04',
      '2026-08-13',
    ]);
  });

  it('значення поза 1..5 притискаються до шкали, а не ламають сітку', () => {
    const r = raw({ '2026-08-13': { morning: { energy: 9, mood: -3 } } });
    expect(readingsOf(r, 'all')).toEqual([
      { d: '2026-08-13', slot: 'morning', energy: 5, mood: 1 },
    ]);
  });

  it('порожнє вікно -> порожній список, не виняток', () => {
    expect(readingsOf(raw({}), 'all')).toEqual([]);
  });

  it('перелік фільтрів починається з «усіх» і містить три слоти', () => {
    expect(SLOT_FILTERS.map((f) => f.id)).toEqual(['all', 'morning', 'afternoon', 'evening']);
  });

  it('підпис фільтра — слово, не сам емодзі (читабельність і скрінрідер)', () => {
    for (const f of SLOT_FILTERS) expect(f.label).toMatch(/\p{L}/u);
  });
});

describe('gridOf — сітка 5×5', () => {
  const at = (energy: number, mood: number, d = '2026-08-13') => ({
    d,
    slot: 'morning' as const,
    energy,
    mood,
  });

  it('геометрія збігається з AffectPad: енергія вгору, настрій вправо', () => {
    const { grid } = gridOf([at(5, 1), at(1, 5)]);
    expect(grid[0]![0]).toBe(1); // енергія 5 · настрій 1 — верх-ліво
    expect(grid[4]![4]).toBe(1); // енергія 1 · настрій 5 — низ-право
  });

  it('однакові зрізи накопичуються в одній клітинці', () => {
    const { grid, max, n } = gridOf([at(3, 3), at(3, 3), at(3, 3)]);
    expect(grid[2]![2]).toBe(3);
    expect(max).toBe(3);
    expect(n).toBe(3);
  });

  it('порожньо -> max=1, щоб ділення на максимум не давало NaN', () => {
    const { max, n } = gridOf([]);
    expect(max).toBe(1);
    expect(n).toBe(0);
  });
});
