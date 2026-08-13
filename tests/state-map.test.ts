import { describe, it, expect } from 'vitest';
import { readingsOf, gridOf, narrowWindow, SLOT_FILTERS } from '../web/app/src/lib/stateMap.ts';
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

/* Фільтр періоду. Працює ЛИШЕ звуженням гарячого вікна: розширити його клієнт
   не може, бо глибших даних у нього просто немає (сервер віддає 90 діб —
   стеля CPU-бюджету). Тому «рік / усе» тут і не зʼявляються: кнопка, яка
   обіцяє період, а показує ті самі 90 діб, гірша за її відсутність. */
describe('narrowWindow — звуження гарячого вікна', () => {
  const day = (back: number) => {
    const d = new Date('2026-08-13T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  };
  const full = raw(
    Object.fromEntries(
      Array.from({ length: 90 }, (_, i) => [day(i), { evening: { energy: 3, mood: 3 } }]),
    ),
  );

  it('лишає рівно стільки діб, скільки просили — межу включно', () => {
    const w = narrowWindow({ ...full, to: day(0) }, 30);
    expect(Object.keys(w.records)).toHaveLength(30);
    expect(w.records[day(29)]).toBeDefined();
    expect(w.records[day(30)]).toBeUndefined();
  });

  it('оголошена глибина звужується разом із даними — підпис не має брехати', () => {
    const w = narrowWindow({ ...full, to: day(0) }, 30);
    expect(w.days).toBe(30);
    expect(w.from).toBe(day(29));
    expect(w.to).toBe(day(0));
  });

  it('ширше за наявне вікно НЕ вигадує даних — віддає що є', () => {
    const w = narrowWindow({ ...full, to: day(0) }, 365);
    expect(w.days).toBe(90);
    expect(Object.keys(w.records)).toHaveLength(90);
  });

  it('порожнє вікно переживає звуження', () => {
    expect(narrowWindow(raw({}), 30).records).toEqual({});
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
