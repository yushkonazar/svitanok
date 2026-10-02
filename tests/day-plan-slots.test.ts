// Розкладка дня (етап 3 PR-8, ADR-035, S-P-11): чистий модуль без D1 і
// мережі. Пінимо правила: жорсткі першими; deep - у вікно з вищою енергією,
// без даних - ранок; типовим оцінкам додається bias, названим - ні; стеля
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
  it('невідомий перетин із подією календаря потребує рішення власника', () => {
    const out = computeSlots({
      date: DATE,
      items: [
        item({ id: 'h', title: 'Дзвінок', kind: 'call', est_min: 60, hard_at: '15:00' }),
        item({ id: 'r', title: 'Пошта', kind: 'routine', est_min: 30 }),
      ],
      events: [{ title: 'Зустріч', startMin: 15 * 60 + 30, endMin: 16 * 60 }],
    });
    expect(out.flexible).toMatchObject([{ id: 'h', why: 'перетин з «Зустріч»' }]);
    expect(out.placed).toMatchObject([{ id: 'r', window_start: '08:00', window_end: '08:30' }]);
  });

  it('прозорий запис календаря не вважається зайнятим часом', () => {
    const out = computeSlots({
      date: DATE,
      items: [item({ id: 'work', title: 'Робота', hard_at: '07:00', hard_end: '19:00' })],
      events: [{ title: 'Сніданок', startMin: 9 * 60, endMin: 9 * 60 + 30, transparent: true }],
    });
    expect(out.placed).toMatchObject([{ id: 'work', window_start: '07:00', window_end: '19:00' }]);
  });

  it('deep без даних енергії - ранок; з енергією (≥ 14 діб) - вікно з вищою енергією', () => {
    const deep = item({ id: 'd', title: 'Презентація', kind: 'deep', est_min: 60 });
    const noEnergy = computeSlots({ date: DATE, items: [deep], events: [] });
    expect(noEnergy.placed[0]).toMatchObject({ window_start: '08:00', window_end: '09:00' });
    expect(noEnergy.placed[0]?.why).toContain('ранок');

    const afternoon = computeSlots({
      date: DATE,
      items: [deep],
      events: [],
      energy: { morning: 2, afternoon: 4, evening: 3 },
    });
    // Обід не резервується автоматично, лише коли його назвав власник.
    expect(afternoon.placed[0]).toMatchObject({ window_start: '13:00' });
    expect(afternoon.placed[0]?.why).toContain('енергія');
  });

  it('зберігає «до вечора» і «увечері», а сьогодні не ставить блоки у минуле', () => {
    const out = computeSlots({
      date: DATE,
      nowMin: 9 * 60 + 3,
      items: [
        item({ id: 'work', title: 'Робота', hard_end: '18:00' }),
        item({ id: 'home', title: 'Додому', kind: 'move', est_min: 30, not_before: '18:00' }),
        item({
          id: 'study',
          title: 'Mate academy',
          kind: 'deep',
          est_min: 60,
          not_before: '18:00',
        }),
        item({ id: 'book', title: 'Книжка', est_min: 30, not_before: '18:00' }),
      ],
      events: [],
      settings: { fill_ratio: 1 },
    });
    expect(out.placed.find((p) => p.id === 'work')).toMatchObject({
      window_start: '09:05',
      window_end: '18:00',
      why: 'до 18:00',
    });
    for (const id of ['home', 'study', 'book']) {
      expect(hhmmToMin(out.placed.find((p) => p.id === id)?.window_start)).toBeGreaterThanOrEqual(
        18 * 60,
      );
    }
    expect(out.placed.find((p) => p.id === 'study')?.why).toContain('після 18:00');
  });

  it('робота 07:00–19:00 лишається цілим блоком; плаваючі їжа й кілька вечірніх справ входять у план', () => {
    const out = computeSlots({
      date: DATE,
      items: [
        item({ id: 'work', title: 'Робота', hard_at: '07:00', hard_end: '19:00' }),
        item({
          id: 'breakfast',
          title: 'Сніданок',
          est_min: 25,
          floating: true,
          overlap_with_item_id: 'work',
        }),
        item({
          id: 'lunch',
          title: 'Обід',
          est_min: 35,
          floating: true,
          overlap_with_item_id: 'work',
        }),
        item({ id: 'project', title: 'Проєкт', kind: 'deep', est_min: 45, after_item_id: 'work' }),
        item({ id: 'book', title: 'Книжка', est_min: 30, after_item_id: 'project' }),
      ],
      events: [],
    });
    expect(out.flexible).toHaveLength(0);
    expect(out.placed.find((p) => p.id === 'work')).toMatchObject({
      window_start: '07:00',
      window_end: '19:00',
    });
    expect(out.placed.find((p) => p.id === 'breakfast')).toMatchObject({
      floating: true,
      est_min: 25,
      window_start: '08:00',
      window_end: '11:00',
    });
    expect(out.placed.find((p) => p.id === 'lunch')).toMatchObject({
      floating: true,
      est_min: 35,
      window_start: '12:00',
      window_end: '15:00',
    });
    expect(
      hhmmToMin(out.placed.find((p) => p.id === 'project')?.window_start),
    ).toBeGreaterThanOrEqual(19 * 60);
    expect(hhmmToMin(out.placed.find((p) => p.id === 'book')?.window_start)).toBeGreaterThanOrEqual(
      hhmmToMin(out.placed.find((p) => p.id === 'project')?.window_end)!,
    );
  });

  it('стійкий фактичний час старту лише підказує початок роботи, явний час власника має перевагу', () => {
    const habits = { work_start_at: '08:05', work_start_samples: 6 };
    const inferred = computeSlots({
      date: DATE,
      items: [item({ id: 'work', title: 'Робота', role: 'work', hard_end: '19:00' })],
      events: [],
      habits,
    });
    expect(inferred.placed[0]).toMatchObject({ window_start: '08:05', window_end: '19:00' });
    expect(inferred.placed[0]?.why).toContain('6 попередніми днями');
    const explicit = computeSlots({
      date: DATE,
      items: [
        item({ id: 'work', title: 'Робота', role: 'work', hard_at: '07:00', hard_end: '19:00' }),
      ],
      events: [],
      habits,
    });
    expect(explicit.placed[0]?.window_start).toBe('07:00');
  });

  it('план на сьогодні починає наступний блок з найближчого кроку, не в минулому', () => {
    const out = computeSlots({
      date: DATE,
      nowMin: 10 * 60 + 2,
      items: [item({ id: 'today', title: 'Пошта', est_min: 30 })],
      events: [],
    });
    expect(out.placed[0]).toMatchObject({ window_start: '10:05', window_end: '10:35' });
  });

  it('не вигадує типовий час після відповіді «не знаю»', () => {
    const out = computeSlots({
      date: DATE,
      items: [
        item({ id: 'study', title: 'Навчання', kind: 'deep', est_min: null, flexible: true }),
        item({ id: 'mail', title: 'Пошта', kind: 'routine', est_min: 30 }),
      ],
      events: [],
    });
    expect(out.placed.map((p) => p.id)).toEqual(['mail']);
    expect(out.flexible).toMatchObject([{ id: 'study', why: 'тривалість не визначена' }]);
  });

  it('після завершення дня не повертає справи на ранок того самого дня', () => {
    const out = computeSlots({
      date: DATE,
      nowMin: 23 * 60,
      items: [item({ id: 'late', title: 'Прочитати книгу', est_min: 30 })],
      events: [],
    });
    expect(out.placed).toHaveLength(0);
    expect(out.flexible[0]?.id).toBe('late');
  });

  it('явний порядок після роботи зберігається попри зайняті вечірні вікна', () => {
    const out = computeSlots({
      date: DATE,
      nowMin: 9 * 60,
      items: [
        item({ id: 'work', title: 'Робота', hard_end: '18:00' }),
        item({ id: 'home', title: 'Додому', kind: 'move', est_min: 30, after_item_id: 'work' }),
        item({ id: 'study', title: 'Навчання', kind: 'deep', est_min: 60, after_item_id: 'home' }),
        item({ id: 'book', title: 'Книжка', est_min: 30, after_item_id: 'study' }),
      ],
      events: [{ title: 'Подія', startMin: 18 * 60 + 45, endMin: 19 * 60 + 15 }],
      settings: { fill_ratio: 1 },
    });
    const study = out.placed.find((p) => p.id === 'study');
    const book = out.placed.find((p) => p.id === 'book');
    expect(study).toBeDefined();
    expect(book).toBeDefined();
    expect(hhmmToMin(book?.window_start)).toBeGreaterThanOrEqual(hhmmToMin(study?.window_end)!);
  });

  it('названі справи не губляться через fill_ratio; межа діє лише для необовʼязкових', () => {
    const items = [1, 2, 3, 4].map((i) =>
      item({ id: `i${i}`, title: `Блок ${i}`, kind: 'routine', est_min: 120 }),
    );
    const out = computeSlots({ date: DATE, items, events: [] });
    expect(out).toMatchObject({ freeMin: 840, capacityMin: 672, usedMin: 480 });
    expect(out.placed).toHaveLength(4);
    const optional = computeSlots({
      date: DATE,
      items: [...items.slice(0, 3), item({ ...items[3]!, optional: true })],
      events: [],
      settings: { fill_ratio: 0.4 },
    });
    expect(optional.flexible[0]).toMatchObject({ id: 'i4', why: 'не влізло в 40 % вільного часу' });
  });

  it('max_deep не викреслює названі справи, лише додаткові', () => {
    const items = [1, 2, 3, 4].map((i) =>
      item({ id: `d${i}`, title: `Глибокий ${i}`, kind: 'deep', est_min: 30 }),
    );
    const out = computeSlots({ date: DATE, items, events: [] });
    expect(out.placed).toHaveLength(4);
    const one = computeSlots({
      date: DATE,
      items: [...items.slice(0, 3), item({ ...items[3]!, optional: true })],
      events: [],
      settings: { max_deep: 1 },
    });
    expect(one.placed).toHaveLength(3);
    expect(one.flexible[0]).toMatchObject({ id: 'd4', why: 'понад 1 глибоких блоків' });
  });

  it('буфер 15 хв навколо події календаря; довгий блок без вікна - «немає вікна»', () => {
    const out = computeSlots({
      date: DATE,
      items: [item({ id: 'd', title: 'Дизайн', kind: 'deep', est_min: 90 })],
      events: [{ title: 'Стендап', startMin: 8 * 60, endMin: 9 * 60 }],
    });
    expect(out.placed[0]).toMatchObject({ window_start: '09:15', window_end: '10:45' });

    const long = computeSlots({
      date: DATE,
      items: [item({ id: 'l', title: 'Марафон', kind: 'deep', est_min: 900 })],
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
        item({ id: 'x', title: 'Марафон', kind: 'deep', est_min: 900 }),
      ],
      events: [{ title: 'Зустріч', startMin: 10 * 60, endMin: 11 * 60 }],
    });
    const text = formatDraft(DATE, slots, [{ title: 'Зустріч', startMin: 10 * 60 }]);
    expect(text.split('\n')[0]).toBe('План на 07.09');
    expect(text).toContain('• 08:00-09:00 Презентація · глибокий блок');
    expect(text).toContain('• 10:00 Зустріч (календар)');
    expect(text).toContain('Потребує рішення: Марафон');
    expect(text).toMatch(/Запас: \d+ год \d+ хв вільно/);
  });
});

describe('помічники', () => {
  it('estimateMin: bias лише для типової оцінки, названий час лишається точним', () => {
    expect(estimateMin(item({ id: 'c', title: 'x', kind: 'call' }), 1.3)).toBe(20);
    expect(estimateMin(item({ id: 'r', title: 'x', kind: 'routine' }), 1.3)).toBe(40);
    expect(estimateMin(item({ id: 'd', title: 'x', kind: 'deep' }), 1.3)).toBe(115);
    expect(estimateMin(item({ id: 's', title: 'x', kind: 'call', est_min: 5 }), 1)).toBe(15);
    // Названу власником тривалість bias не «ламає» - лише додає запас.
    expect(estimateMin(item({ id: 'o', title: 'x', kind: 'deep', est_min: 100 }), 1)).toBe(100);
    expect(estimateMin(item({ id: 'o2', title: 'x', est_min: 30 }), 1.3)).toBe(30);
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
