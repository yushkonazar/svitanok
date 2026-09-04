// Розкладка дня (етап 3 PR-8, ADR-035, S-P-11): чистий модуль без D1 і
// мережі. Пінимо правила: жорсткі першими; deep - у вікно з вищою енергією,
// без даних - ранок; оцінка × estimate_bias з округленням до 5 хв; стеля
// fill_ratio і max_deep; буфер навколо подій; errand за місцем підряд;
// що не влізло - «гнучке без часу» з причиною.

import { describe, it, expect } from 'vitest';
import {
  computeSlots,
  formatDraft,
  estimateMin,
  energyBySlot,
  parseWeekdays,
  isoWeekday,
  hhmmToMin,
  minToHhmm,
  ENERGY_MIN_DAYS,
} from '../web/core/day-plan/slots.mjs';

const DATE = '2026-09-07';
type Item = Parameters<typeof computeSlots>[0]['items'][number];

function item(over: Partial<Item> & { id: string; title: string }): Item {
  return {
    kind: 'routine',
    est_min: null,
    hard_at: null,
    deadline: null,
    place: null,
    flexible: false,
    priority: 5,
    ...over,
  };
}

describe('computeSlots - правила S-P-11', () => {
  it('жорсткий час - у свій час навіть поверх події; перетин лише названо в why; placed відсортовано', () => {
    const out = computeSlots({
      date: DATE,
      items: [
        item({ id: 'h', title: 'Дзвінок', kind: 'call', est_min: 60, hard_at: '15:00' }),
        item({ id: 'r', title: 'Пошта', kind: 'routine', est_min: 30 }),
      ],
      events: [{ title: 'Зустріч', startMin: 15 * 60 + 30, endMin: 16 * 60 }],
    });
    const hard = out.placed.find((p) => p.id === 'h');
    // 60 × 1,3 = 78 → 80 хв.
    expect(hard).toMatchObject({ window_start: '15:00', window_end: '16:20', est_min: 80 });
    expect(hard?.why).toBe('жорсткий час; перетин з «Зустріч»');
    expect(out.placed.map((p) => p.id)).toEqual(['r', 'h']);
    expect(out.placed[0]).toMatchObject({ window_start: '08:00', window_end: '08:40' });
  });

  it('deep без даних енергії - ранок; з енергією (≥ 14 діб) - вікно з вищою енергією', () => {
    const deep = item({ id: 'd', title: 'Презентація', kind: 'deep', est_min: 60 });
    const noEnergy = computeSlots({ date: DATE, items: [deep], events: [] });
    expect(noEnergy.placed[0]).toMatchObject({ window_start: '08:00', window_end: '09:20' });
    expect(noEnergy.placed[0]?.why).toContain('ранок');

    const afternoon = computeSlots({
      date: DATE,
      items: [deep],
      events: [],
      energy: { morning: 2, afternoon: 4, evening: 3 },
    });
    // Вікно 13:00-18:00, обід 13:00-14:00 зайнятий → 14:00.
    expect(afternoon.placed[0]).toMatchObject({ window_start: '14:00' });
    expect(afternoon.placed[0]?.why).toContain('енергія');
  });

  it('заповнення ≤ fill_ratio вільного часу: 4-й блок - гнучкий із причиною', () => {
    const items = [1, 2, 3, 4].map((i) =>
      item({ id: `i${i}`, title: `Блок ${i}`, kind: 'routine', est_min: 120 }),
    );
    const out = computeSlots({ date: DATE, items, events: [] });
    // 08:00-22:00 = 840 − обід 60 = 780; 60 % = 468; 120 × 1,3 = 156 → 155,
    // 3 × 155 = 465 влазить, четвертий - ні.
    expect(out).toMatchObject({ freeMin: 780, capacityMin: 468, usedMin: 465 });
    expect(out.placed).toHaveLength(3);
    expect(out.flexible.map((f) => [f.id, f.why])).toEqual([
      ['i4', 'не влізло в 60 % вільного часу'],
    ]);
  });

  it('≤ max_deep глибоких блоків; понад стелю - гнучке', () => {
    const items = [1, 2, 3, 4].map((i) =>
      item({ id: `d${i}`, title: `Глибокий ${i}`, kind: 'deep', est_min: 30 }),
    );
    const out = computeSlots({ date: DATE, items, events: [] });
    expect(out.placed).toHaveLength(3);
    expect(out.flexible[0]).toMatchObject({ id: 'd4', why: 'понад 3 глибоких блоків' });
    const one = computeSlots({ date: DATE, items, events: [], settings: { max_deep: 1 } });
    expect(one.placed).toHaveLength(1);
  });

  it('буфер 15 хв навколо події календаря; довгий блок без вікна - «немає вікна»', () => {
    const out = computeSlots({
      date: DATE,
      items: [item({ id: 'd', title: 'Дизайн', kind: 'deep', est_min: 90 })],
      events: [{ title: 'Стендап', startMin: 8 * 60, endMin: 9 * 60 }],
    });
    // 90 × 1,3 = 117 → 115; після події + буфер: 09:15.
    expect(out.placed[0]).toMatchObject({ window_start: '09:15', window_end: '11:10' });

    const long = computeSlots({
      date: DATE,
      items: [item({ id: 'l', title: 'Марафон', kind: 'deep', est_min: 600 })],
      events: [],
      settings: { fill_ratio: 1 },
    });
    expect(long.placed).toHaveLength(0);
    expect(long.flexible[0]?.why).toBe('немає вікна потрібної довжини');
  });

  it('пріоритет: дедлайн сьогодні → перенесені → порядок власника; errand за місцем підряд', () => {
    const out = computeSlots({
      date: DATE,
      items: [
        item({ id: 'a', title: 'Пошта', kind: 'routine', est_min: 30 }),
        item({ id: 'b', title: 'Звіт', kind: 'routine', est_min: 30, deadline: DATE }),
        item({ id: 'c', title: 'Банк', kind: 'errand', est_min: 30, place: 'Центр' }),
        item({ id: 'e', title: 'Кава', kind: 'routine', est_min: 30 }),
        item({ id: 'f', title: 'Пошта Укрпошта', kind: 'errand', est_min: 30, place: 'центр' }),
        item({
          id: 'g',
          title: 'Дзвінок мамі',
          kind: 'call',
          est_min: 15,
          carried_from: '2026-09-04',
        }),
      ],
      events: [],
    });
    const order = out.placed.map((p) => p.id);
    expect(order[0]).toBe('b');
    expect(order[1]).toBe('g');
    expect(out.placed.find((p) => p.id === 'b')?.why).toBe(`дедлайн ${DATE}`);
    expect(out.placed.find((p) => p.id === 'g')?.why).toBe('перенесено з 2026-09-04');
    // Два errand з тим самим місцем (без регістру) - сусідні блоки.
    expect(order.indexOf('f')).toBe(order.indexOf('c') + 1);
  });

  it('formatDraft: дата, блоки з причиною, події календаря, гнучке, запас', () => {
    const slots = computeSlots({
      date: DATE,
      items: [
        item({ id: 'd', title: 'Презентація', kind: 'deep', est_min: 60 }),
        item({ id: 'x', title: 'Марафон', kind: 'deep', est_min: 600 }),
      ],
      events: [{ title: 'Зустріч', startMin: 10 * 60, endMin: 11 * 60 }],
    });
    const text = formatDraft(DATE, slots, [{ title: 'Зустріч', startMin: 10 * 60 }]);
    expect(text.split('\n')[0]).toBe('План на 07.09');
    expect(text).toContain('• 08:00-09:20 Презентація · deep · глибокий блок');
    expect(text).toContain('• 10:00 Зустріч (календар)');
    expect(text).toContain('Гнучке, без часу: Марафон');
    expect(text).toMatch(/Запас: \d+ год \d+ хв вільно/);
  });
});

describe('помічники', () => {
  it('estimateMin: типова тривалість за видом × bias, крок 5 хв, мінімум 15', () => {
    expect(estimateMin(item({ id: 'c', title: 'x', kind: 'call' }), 1.3)).toBe(20);
    expect(estimateMin(item({ id: 'r', title: 'x', kind: 'routine' }), 1.3)).toBe(40);
    expect(estimateMin(item({ id: 'd', title: 'x', kind: 'deep' }), 1.3)).toBe(115);
    expect(estimateMin(item({ id: 's', title: 'x', kind: 'call', est_min: 5 }), 1)).toBe(15);
    // Названу власником тривалість bias не «ламає» - лише додає запас.
    expect(estimateMin(item({ id: 'o', title: 'x', kind: 'deep', est_min: 100 }), 1)).toBe(100);
  });

  it('energyBySlot: середні по вікнах лише з ≥ 14 діб, інакше null', () => {
    const checkins: Record<string, unknown> = {};
    for (let i = 1; i <= ENERGY_MIN_DAYS; i += 1) {
      checkins[`2026-08-${String(i).padStart(2, '0')}`] = {
        morning: { energy: 2 },
        afternoon: { energy: 4 },
        evening: { energy: 3 },
      };
    }
    expect(energyBySlot(checkins)).toEqual({ morning: 2, afternoon: 4, evening: 3, days: 14 });
    delete checkins['2026-08-14'];
    expect(energyBySlot(checkins)).toBeNull();
    expect(energyBySlot({})).toBeNull();
  });

  it('parseWeekdays/isoWeekday/hhmm', () => {
    expect([...parseWeekdays('пн-пт')].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(isoWeekday('2026-09-05')).toBe(6);
    expect(isoWeekday('2026-09-06')).toBe(7);
    expect(isoWeekday('2026-09-07')).toBe(1);
    expect(hhmmToMin('9:05')).toBe(545);
    expect(hhmmToMin('abc')).toBeNull();
    expect(minToHhmm(545)).toBe('09:05');
  });
});
