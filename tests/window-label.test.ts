import { describe, it, expect } from 'vitest';
import { daysWindowLabel, weeksWindowLabel } from '../web/app/src/lib/windowLabel.ts';

// Підпис глибини. Дрібниця на вигляд, але саме він відрізняє «за останні 12
// днів» від «12 заповнених діб із останніх 30» — а це різні твердження про
// одні й ті самі числа.

describe('daysWindowLabel', () => {
  it('вікно без наповненості — коли блок читає кожну добу', () => {
    expect(daysWindowLabel(30)).toBe('ЗА 30 ДІБ');
  });

  it('вікно + скільки в ньому заповнено — два РІЗНІ числа', () => {
    expect(daysWindowLabel(30, 12)).toBe('ЗА 30 ДІБ · 12 ЗАПОВНЕНО');
  });

  it('нуль заповнених не ховається — порожньо теж відповідь', () => {
    expect(daysWindowLabel(60, 0)).toBe('ЗА 60 ДІБ · 0 ЗАПОВНЕНО');
  });

  it('відмінок доби живий: 1 / 22 / 5 / пастка 11-14', () => {
    expect(daysWindowLabel(1)).toBe('ЗА 1 ДОБУ');
    expect(daysWindowLabel(22)).toBe('ЗА 22 ДОБИ');
    expect(daysWindowLabel(5)).toBe('ЗА 5 ДІБ');
    expect(daysWindowLabel(12)).toBe('ЗА 12 ДІБ');
    expect(daysWindowLabel(14)).toBe('ЗА 14 ДІБ');
  });
});

describe('weeksWindowLabel', () => {
  it('відмінок тижня живий', () => {
    expect(weeksWindowLabel(1)).toBe('ЗА 1 ТИЖДЕНЬ');
    expect(weeksWindowLabel(2)).toBe('ЗА 2 ТИЖНІ');
    expect(weeksWindowLabel(8)).toBe('ЗА 8 ТИЖНІВ');
    expect(weeksWindowLabel(12)).toBe('ЗА 12 ТИЖНІВ');
    expect(weeksWindowLabel(26)).toBe('ЗА 26 ТИЖНІВ');
  });
});
