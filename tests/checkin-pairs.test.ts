import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів
import { emptyStore, recordEvent, aggregateStats } from '../web/stats-core.mjs';

/* Дві агрегації, що існують РАДИ ОДНОГО: щоб нові ранкові питання не
 * збирались у пусту.
 *
 * ⚠️ dayExpect навмисно НЕ входить у жоден індекс моделі — воно описує прогноз
 * про добу, а не саму добу, і змішати їх означало б зробити «Індекс дня»
 * частково передбаченням самого себе. Тому «Очікування проти реальності» —
 * ЄДИНИЙ його споживач: без цієї функції поле не читалось би ніде.
 *
 * movePlan живить BODY сам по собі, але пару «намір проти факту» без
 * buildMoveIntent не побачив би ніхто. */

const TODAY = '2026-08-16';
const ck = (slot: string, fields: Record<string, unknown>) => ({
  type: 'checkin',
  slot,
  ...fields,
});

/** n діб поспіль з однаковими ранком і вечором. */
function build(n: number, morning: Record<string, unknown>, evening: Record<string, unknown>) {
  let s = emptyStore();
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    const key = d.toISOString().slice(0, 10);
    s = recordEvent(s, ck('morning', morning), key);
    s = recordEvent(s, ck('evening', evening), key);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return s;
}

describe('expectCalibration — очікування проти реальності', () => {
  it('дні кращі за прогноз -> додатний зсув', () => {
    const c = aggregateStats(build(12, { dayExpect: 3 }, { dayScore: 4 }), TODAY).expectCalibration;
    expect(c.ready).toBe(true);
    expect(c.bias).toBe(1);
    expect(c.better).toBe(12);
    expect(c.worse).toBe(0);
  });

  it('дні гірші за прогноз -> відʼємний зсув', () => {
    const c = aggregateStats(build(12, { dayExpect: 5 }, { dayScore: 3 }), TODAY).expectCalibration;
    expect(c.bias).toBe(-2);
    expect(c.worse).toBe(12);
  });

  /* ⚠️ Три кошики поруч не зайві: bias=0 буває і коли щодня влучаєш, і коли
     половина днів краща, а половина гірша. Це різні люди, і середнє їх
     плутає. */
  it('нульовий зсув НЕ означає «щодня точно» — кошики це розрізняють', () => {
    let s = emptyStore();
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 11);
    for (let i = 0; i < 12; i++) {
      const key = d.toISOString().slice(0, 10);
      s = recordEvent(s, ck('morning', { dayExpect: 3 }), key);
      s = recordEvent(s, ck('evening', { dayScore: i % 2 ? 5 : 1 }), key);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const c = aggregateStats(s, TODAY).expectCalibration;
    expect(c.bias).toBe(0);
    expect(c.better).toBe(6);
    expect(c.worse).toBe(6);
    expect(c.same).toBe(0);
  });

  it('замало пар -> ready=false з лічильником, а не вигаданий зсув', () => {
    const c = aggregateStats(build(3, { dayExpect: 3 }, { dayScore: 4 }), TODAY).expectCalibration;
    expect(c.ready).toBe(false);
    expect(c.n).toBe(3);
    expect(c.needed).toBeGreaterThan(3);
  });

  it('доба без однієї з двох відповідей у пару не йде', () => {
    const c = aggregateStats(build(12, {}, { dayScore: 4 }), TODAY).expectCalibration;
    expect(c.n).toBe(0);
  });
});

describe('moveIntent — намір руху проти факту', () => {
  it('факт НЕ НИЖЧИЙ за план — намір виконано', () => {
    // Планував легкий рух, вийшло тренування: це виконано, а не «мимо».
    const m = aggregateStats(
      build(8, { movePlan: 'light' }, { moved: 'workout' }),
      TODAY,
    ).moveIntent;
    expect(m.ready).toBe(true);
    expect(m.planned).toBe(8);
    expect(m.kept).toBe(8);
    expect(m.keptPct).toBe(100);
  });

  it('факт нижчий за план — намір не виконано', () => {
    const m = aggregateStats(
      build(8, { movePlan: 'workout' }, { moved: 'light' }),
      TODAY,
    ).moveIntent;
    expect(m.kept).toBe(0);
    expect(m.keptPct).toBe(0);
  });

  /* Друге питання блоку, і воно ПРО ІНШЕ: скільки разів рух стався там, де
     його не планували. Звести обидва в один відсоток означало б утратити
     половину картини. */
  it('рух без плану рахується окремо, а не як «невиконаний намір»', () => {
    const m = aggregateStats(build(8, { movePlan: 'none' }, { moved: 'active' }), TODAY).moveIntent;
    expect(m.planned).toBe(0);
    expect(m.noPlanDays).toBe(8);
    expect(m.noPlanButMoved).toBe(8);
    // ⚠️ Порожній знаменник -> null, а не 0%: «нуль із нуля» і «нуль із
    // десяти» — різні твердження. Той самий урок, що з конверсіями воронки.
    expect(m.keptPct).toBeNull();
  });

  it('замало діб -> ready=false', () => {
    const m = aggregateStats(build(2, { movePlan: 'light' }, { moved: 'light' }), TODAY).moveIntent;
    expect(m.ready).toBe(false);
  });
});
