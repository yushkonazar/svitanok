import { describe, it, expect } from 'vitest';
import { interestShifts, focusPct } from '../web/app/src/lib/interestShift.ts';

// Рух в інтересах.
//
// ⚠️ Блок показував ЗНІМОК: головна тема, чипи решти, бал і графік. Напрямок
// був видний лише в головної теми — тобто саме тієї, про яку й так усе ясно.
// Цікаве ж у інтересах — рух: тема, що тихо піднялась із нізвідки, або та, що
// згасла й висить у топі за старими заслугами. Дані для цього лежали в
// interestsTrend від початку, читались із них два останні елементи.

const trend = (topics: Record<string, number[]>) => ({
  weeks: [],
  topics: Object.entries(topics).map(([topic, series]) => ({ topic, series })),
});

describe('interestShifts', () => {
  it('зростання помічається', () => {
    const r = interestShifts(trend({ Наука: [0, 1, 0, 1, 5, 6, 7, 8] }));
    expect(r[0]).toMatchObject({ topic: 'Наука', direction: 'up' });
    expect(r[0]!.recent).toBe(26);
    expect(r[0]!.prior).toBe(2);
  });

  it('згасання помічається так само', () => {
    const r = interestShifts(trend({ Політика: [8, 7, 6, 5, 0, 1, 0, 0] }));
    expect(r[0]).toMatchObject({ topic: 'Політика', direction: 'down' });
  });

  it('рівна тема не потрапляє — це не рух', () => {
    expect(interestShifts(trend({ Технології: [5, 5, 5, 5, 5, 5, 5, 5] }))).toEqual([]);
  });

  it('дрібне коливання не потрапляє', () => {
    // 20 -> 24: помітно на око, але це не зміна інтересу.
    expect(interestShifts(trend({ Спорт: [5, 5, 5, 5, 6, 6, 6, 6] }))).toEqual([]);
  });

  it('тиша по обидва боки — не рух, навіть якщо кратність велика', () => {
    // 0 -> 2: удвічі «більше», але це дві реакції.
    expect(interestShifts(trend({ Мода: [0, 0, 0, 0, 0, 1, 1, 0] }))).toEqual([]);
  });

  it('нова тема (0 -> багато) дає ЧИСЛО, а не нескінченність', () => {
    const r = interestShifts(trend({ Нова: [0, 0, 0, 0, 4, 4, 4, 4] }));
    expect(r).toHaveLength(1);
    expect(Number.isFinite(r[0]!.ratio)).toBe(true);
  });

  it('короткої історії не вистачає: нема з чим порівнювати', () => {
    // Три тижні — попереднього періоду не існує, і «нова тема» виглядала б
    // вибуховим зростанням просто тому, що застосунку тиждень тому не було.
    expect(interestShifts(trend({ Наука: [0, 5, 9] }))).toEqual([]);
  });

  it('найсильніший рух перший, у будь-який бік', () => {
    // ⚠️ Сила міряється кратністю, а не різницею балів, тож падіння 36->0
    // сильніше за зростання 16->32. Це не дрібниця сортування: у списку з
    // трьох тем угорі має стояти та, де інтерес змінився НАЙБІЛЬШЕ разів, а
    // не та, де більший абсолютний бал.
    const r = interestShifts(
      trend({
        Слабке: [4, 4, 4, 4, 8, 8, 8, 8], // ×1.9
        Сильне: [0, 0, 0, 0, 12, 12, 12, 12], // з нуля
        Падіння: [9, 9, 9, 9, 0, 0, 0, 0], // у нуль
      }),
    );
    expect(r.map((x) => x.topic)).toEqual(['Сильне', 'Падіння', 'Слабке']);
    expect(r.map((x) => x.direction)).toEqual(['up', 'down', 'up']);
  });

  it('порожній тренд -> порожньо', () => {
    expect(interestShifts(trend({}))).toEqual([]);
  });
});

describe('focusPct — наскільки вузькі інтереси', () => {
  it('частка найбільшої теми від усіх реакцій', () => {
    expect(
      focusPct([
        { topic: 'a', score: 7 },
        { topic: 'b', score: 2 },
        { topic: 'c', score: 1 },
      ]),
    ).toBe(70);
  });

  it('без реакцій -> null, а не 0% (це різні відповіді)', () => {
    expect(focusPct([])).toBeNull();
    expect(focusPct([{ topic: 'a', score: 0 }])).toBeNull();
  });

  it('одна тема -> 100%', () => {
    expect(focusPct([{ topic: 'a', score: 5 }])).toBe(100);
  });
});
