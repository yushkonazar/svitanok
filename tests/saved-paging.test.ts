import { describe, it, expect } from 'vitest';
import { nextSavedOffset, type Page } from '../web/app/src/api/paging.ts';

// Гортання архіву збереженого (екран «Збережене»).
//
// Регресія, яку тут прибито: старий екран просив дедалі більший limit
// (20→40→60…) при зашитому offset=0, а сервер клампить limit до SAVED_PAGE_MAX=50
// (pageSaved у web/stats-core.mjs). Тобто після 50-го запису «Показати ще (N)»
// показувало чесний залишок, але не додавало НІЧОГО. Гортаємо offset'ом.

const page = (n: number, total: number): Page => ({ items: Array.from({ length: n }), total });

describe('nextSavedOffset — гортання архіву', () => {
  it('перша повна сторінка з довгого архіву -> offset наступної', () => {
    expect(nextSavedOffset([page(50, 120)])).toBe(50);
  });

  it('середина: offset = скільки вже набрано, а не номер сторінки', () => {
    expect(nextSavedOffset([page(50, 120), page(50, 120)])).toBe(100);
  });

  it('набрали все -> стоп', () => {
    expect(nextSavedOffset([page(50, 120), page(50, 120), page(20, 120)])).toBeUndefined();
  });

  it('архів рівно в одну сторінку -> стоп (а не порожній запит по колу)', () => {
    expect(nextSavedOffset([page(50, 50)])).toBeUndefined();
  });

  it('архів коротший за сторінку -> стоп', () => {
    expect(nextSavedOffset([page(5, 5)])).toBeUndefined();
  });

  it('порожній архів -> стоп', () => {
    expect(nextSavedOffset([page(0, 0)])).toBeUndefined();
  });

  it('порожня сторінка спиняє, навіть якщо total бреше більше', () => {
    // total читається з KV, який відстає (~60с без read-your-writes). Якби
    // спинялись ЛИШЕ по лічильнику, крутили б порожні сторінки вічно.
    expect(nextSavedOffset([page(50, 999), page(0, 999)])).toBeUndefined();
  });

  it('сервер віддав менше, ніж просили, але total ще не добрано -> гортаємо далі', () => {
    // Не наш кламп: просто зріз закінчився рівно на межі. Наступний запит
    // віддасть порожньо й спинить нас попереднім правилом.
    expect(nextSavedOffset([page(30, 120)])).toBe(30);
  });

  it('порожній список сторінок -> стоп (перший запит іде з initialPageParam)', () => {
    expect(nextSavedOffset([])).toBeUndefined();
  });
});
