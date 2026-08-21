import { describe, it, expect } from 'vitest';
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';

/* mockRated: таймстемп і тема на оцінці.
 *
 * ⚠️ ЧОМУ ЦЕ БУВ БОРГ. Запис був {qId: 'easy'|'hard'} — без часу й без теми.
 * Через це блокувались одразу дві речі, і обидві згадувались у попередніх
 * проходах як «свідомо не зроблено»:
 *   1. тренд «чи стає легше» — порядок ключів у JS-обʼєкті не гарантований
 *      (усе-цифровий base36-ключ рушає на початок), тож будувати хронологію на
 *      ньому означало б показати як висновок те, що може мовчки перевернутись;
 *   2. «останні N по КОЖНІЙ темі» — qId не знав своєї теми.
 *
 * Легасі-форма (голий рядок) лежить у KV роками: читати її ОБОВʼЯЗКОВО, інакше
 * вся історія оцінок зникне в день деплою. */

const TODAY = '2026-08-13';
const back = (n: number) => {
  const d = new Date(TODAY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const rate = (s: unknown, qId: string, rating: string, topic: string, daysAgo = 0) =>
  recordEvent(s, { type: 'mock_answer', qId, rating, topic }, back(daysAgo));

describe('recordEvent — оцінка несе час і тему', () => {
  it('нова оцінка пишеться обʼєктом із датою й темою', () => {
    const s = rate(emptyStore(), 'q1', 'easy', 'HTTP', 3);
    expect(s.mockRated.q1).toEqual({ r: 'easy', at: back(3), topic: 'HTTP' });
  });

  it('зміна думки оновлює оцінку Й дату — свіжість стосується РІШЕННЯ', () => {
    let s = rate(emptyStore(), 'q1', 'hard', 'HTTP', 10);
    s = rate(s, 'q1', 'easy', 'HTTP', 2);
    expect(s.mockRated.q1.r).toBe('easy');
    expect(s.mockRated.q1.at).toBe(back(2));
  });

  it('легасі-рядок читається як оцінка без часу, а не як сміття', () => {
    const s = emptyStore();
    s.mockRated.old = 'easy';
    const agg = aggregateStats(s, TODAY);
    // Стара оцінка й далі рахується в загальному відсотку.
    expect(agg.mock.recentEasyPct).toBe(100);
  });

  it('легасі-запис не валить тренд — просто не має куди лягти в часі', () => {
    const s = emptyStore();
    s.mockRated.old = 'hard';
    expect(() => aggregateStats(s, TODAY)).not.toThrow();
  });

  it('кап 60 лишається: найстаріші оцінки витісняються', () => {
    let s = emptyStore();
    for (let i = 0; i < 70; i++) s = rate(s, `q${i}`, 'easy', 'HTTP', 0);
    expect(Object.keys(s.mockRated)).toHaveLength(60);
    expect(s.mockRated.q0).toBeUndefined();
  });

  it('дедуп по qId не зламався: повторна оцінка не бампає seen удруге', () => {
    let s = rate(emptyStore(), 'q1', 'hard', 'HTTP', 0);
    s = rate(s, 'q1', 'hard', 'HTTP', 0);
    expect(s.mockTopics.HTTP.seen).toBe(1);
  });
});

describe('mock.easeTrend — чи стає легше', () => {
  it('тижневий ряд рахується за ЧАСОМ оцінки, а не за порядком ключів', () => {
    let s = emptyStore();
    // Давні — складні, свіжі — легкі.
    for (let i = 0; i < 6; i++) s = rate(s, `old${i}`, 'hard', 'HTTP', 40 + i);
    for (let i = 0; i < 6; i++) s = rate(s, `new${i}`, 'easy', 'HTTP', 1 + i);
    const trend = aggregateStats(s, TODAY).mock.easeTrend;
    const withData = trend.filter((w: { n: number }) => w.n > 0);
    expect(withData[0]!.easePct).toBe(0);
    expect(withData[withData.length - 1]!.easePct).toBe(100);
  });

  it('тиждень без оцінок -> easePct null, а не нуль', () => {
    const s = rate(emptyStore(), 'q1', 'easy', 'HTTP', 0);
    const trend = aggregateStats(s, TODAY).mock.easeTrend;
    const empty = trend.filter((w: { n: number }) => w.n === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const w of empty) expect(w.easePct).toBeNull();
  });

  it('легасі-оцінки без часу в тренд НЕ потрапляють (їх нікуди покласти)', () => {
    const s = emptyStore();
    s.mockRated.old = 'easy';
    const trend = aggregateStats(s, TODAY).mock.easeTrend;
    expect(trend.every((w: { n: number }) => w.n === 0)).toBe(true);
  });

  it('порожній стор -> ряд є, але порожній, і це не виняток', () => {
    const trend = aggregateStats(emptyStore(), TODAY).mock.easeTrend;
    expect(trend.length).toBeGreaterThan(0);
    expect(trend.every((w: { n: number }) => w.n === 0)).toBe(true);
  });
});

describe('mock.recentByTopic — як дається ЗАРАЗ, а не за весь час', () => {
  it('рахує лише оцінки з вікна й розкладає по темах', () => {
    let s = rate(emptyStore(), 'a', 'hard', 'HTTP', 2);
    s = rate(s, 'b', 'easy', 'HTTP', 3);
    s = rate(s, 'c', 'easy', 'Алгоритми', 1);
    const rec = aggregateStats(s, TODAY).mock.recentByTopic;
    expect(rec.HTTP).toEqual({ seen: 2, weak: 1 });
    expect(rec['Алгоритми']).toEqual({ seen: 1, weak: 0 });
  });

  it('оцінка без теми (легасі) нікуди не приписується', () => {
    const s = emptyStore();
    s.mockRated.old = 'hard';
    expect(aggregateStats(s, TODAY).mock.recentByTopic).toEqual({});
  });
});

/* ⚠️ РЕГРЕСІЯ, яку внесла сама ця зміна й зловили наявні тести: дедуп по qId
   порівнював сирий запис із рядком-оцінкою. Відколи запис став обʼєктом,
   `prev !== rating` істинне ЗАВЖДИ — і кожен повторний тап накручував weak,
   тобто «слабкість» теми росла від самого гортання картки.

   Другий бік тієї ж зміни: КОНТРАКТ назовні лишився пласким. Клієнт читає
   mockRated рівно для одного — підсвітити вже обрану оцінку в картці питання;
   час і тема потрібні тільки серверним зрізам. */
describe('mockRated — межа між сховищем і контрактом', () => {
  it('повторний тап НЕ накручує weak (дедуп по qId живий)', () => {
    let s = rate(emptyStore(), 'q1', 'hard', 'HTTP', 0);
    for (let i = 0; i < 5; i++) s = rate(s, 'q1', 'hard', 'HTTP', 0);
    expect(s.mockTopics.HTTP).toEqual({ seen: 1, weak: 1 });
  });

  it('зміна думки hard -> easy знімає weak, а не додає ще один', () => {
    let s = rate(emptyStore(), 'q1', 'hard', 'HTTP', 0);
    s = rate(s, 'q1', 'easy', 'HTTP', 0);
    expect(s.mockTopics.HTTP).toEqual({ seen: 1, weak: 0 });
  });

  it('назовні їде ПЛАСКА форма — гідратація картки питання не зламалась', () => {
    const s = rate(emptyStore(), 'q1', 'easy', 'HTTP', 0);
    expect(aggregateStats(s, TODAY).mockRated.q1).toBe('easy');
  });

  it('легасі-запис у контракті виглядає так само, як новий', () => {
    const s = rate(emptyStore(), 'q1', 'easy', 'HTTP', 0);
    s.mockRated.q2 = 'hard';
    expect(aggregateStats(s, TODAY).mockRated).toEqual({ q1: 'easy', q2: 'hard' });
  });

  it('битий запис у контракт не потрапляє взагалі', () => {
    const s = emptyStore();
    s.mockRated.broken = { r: 'нісенітниця' };
    s.mockRated.alsoBroken = 42;
    expect(aggregateStats(s, TODAY).mockRated).toEqual({});
  });
});
