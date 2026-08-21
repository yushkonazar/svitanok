import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// ⚠️ Кілька імпортів, а не один список: prettier переносить довгий список на
// кілька рядків, і однорядковий @ts-expect-error відʼїжджає від рядка з
// помилкою (та сама причина, що в checkin-model.test.ts).
import { acf1, effN, bhKeep, modeShare } from '../web/levers-core.mjs';
import { levelSamples, diffSamples, seriesUsable, contrast } from '../web/levers-core.mjs';
import { analyzeLevers, buildWeeklySeries } from '../web/levers-core.mjs';
import { LEVER_FEATURES, LEVER_FEATURE_KEYS, LEVER_HYPOTHESES } from '../web/levers-core.mjs';
import { LEVERS_Q, MIN_PAIR_N, GATE_WEEKS, USEFUL_WEEKS } from '../web/levers-core.mjs';
import { MIN_CHECKIN_DAYS, MAX_MODE_SHARE, MIN_DISTINCT } from '../web/levers-core.mjs';
import { spearman } from '../web/checkin-model.mjs';

// Золоті вектори — згенеровані research/levers_model.py (numpy/scipy, та сама
// математика в читабельному вигляді). Розбіжність тут = регресія ПОРТУ, а не
// «трохи інша, але прийнятна» відповідь: у моделі немає жодного PRNG на шляху
// від даних до рядка (жодних перестановок, жодного бутстрепа) саме заради
// того, щоб це порівняння мало сенс.
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'levers-golden.json'), 'utf8'));

const near = (a: number | null | undefined, b: number | null | undefined, eps = 1e-6) => {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < eps;
};

describe('levers-core — контракт із Python-оракулом', () => {
  it('порядок ознак той самий (золоті вектори позиційні)', () => {
    expect(LEVER_FEATURE_KEYS).toEqual(golden.featureOrder);
  });

  it('домен кожної ознаки збігається', () => {
    for (const f of LEVER_FEATURES) expect(f.domain).toBe(golden.domains[f.key]);
  });

  /* ⚠️ Список гіпотез — ЧАСТИНА математики, не оформлення: BH ділить бюджет
     помилки на його довжину. Дописали пару з одного боку — поріг зсунувся, і
     золоті вектори порівнювали б різні моделі. */
  it('курований список гіпотез той самий і тієї ж довжини', () => {
    expect(LEVER_HYPOTHESES.map((h) => [h.from, h.to, h.lag])).toEqual(golden.hypotheses);
  });

  it('константи ті самі', () => {
    expect(golden.constants.Q).toBe(LEVERS_Q);
    expect(golden.constants.MIN_PAIR_N).toBe(MIN_PAIR_N);
    expect(golden.constants.GATE_WEEKS).toBe(GATE_WEEKS);
    expect(golden.constants.USEFUL_WEEKS).toBe(USEFUL_WEEKS);
    expect(golden.constants.MIN_CHECKIN_DAYS).toBe(MIN_CHECKIN_DAYS);
    expect(golden.constants.MAX_MODE_SHARE).toBe(MAX_MODE_SHARE);
    expect(golden.constants.MIN_DISTINCT).toBe(MIN_DISTINCT);
  });
});

describe('levers-core — будівельні блоки проти оракула', () => {
  it.each(golden.units.acf1 as Array<{ xs: number[]; want: number }>)(
    'acf1(%#) збігається з Python',
    ({ xs, want }) => {
      expect(near(acf1(xs), want)).toBe(true);
    },
  );

  it.each(golden.units.effN as Array<{ xs: number[]; ys: number[]; want: number }>)(
    'effN(%#) збігається з Python',
    ({ xs, ys, want }) => {
      expect(near(effN(xs, ys), want)).toBe(true);
    },
  );

  it.each(golden.units.spearman as Array<{ xs: number[]; ys: number[]; rho: number; p: number }>)(
    'spearman(%#) — rho і p збігаються з scipy',
    ({ xs, ys, rho, p }) => {
      const got = spearman(xs, ys);
      expect(near(got.rho, rho)).toBe(true);
      expect(near(got.p, p)).toBe(true);
    },
  );

  it.each(
    golden.units.spearmanEffN as Array<{ xs: number[]; ys: number[]; nEff: number; p: number }>,
  )('spearman з nEff(%#) — p рахується на ефективному N', ({ xs, ys, nEff, p }) => {
    expect(near(spearman(xs, ys, nEff).p, p)).toBe(true);
  });

  it.each(golden.units.bh as Array<{ p: number[]; want: boolean[] }>)(
    'bhKeep(%#) збігається з Python',
    ({ p, want }) => {
      expect(bhKeep(p)).toEqual(want);
    },
  );

  it.each(golden.units.modeShare as Array<{ xs: number[]; want: number }>)(
    'modeShare(%#) збігається з Python',
    ({ xs, want }) => {
      expect(near(modeShare(xs), want)).toBe(true);
    },
  );

  it.each(golden.units.seriesUsable as Array<{ xs: number[]; want: boolean }>)(
    'seriesUsable(%#) — той самий вердикт',
    ({ xs, want }) => {
      expect(seriesUsable(xs).ok).toBe(want);
    },
  );

  it.each(
    golden.units.levelSamples as Array<{
      drv: (number | null)[];
      tgt: (number | null)[];
      lag: number;
      want: [number[], number[]];
    }>,
  )('levelSamples(%#) — те саме вирівнювання', ({ drv, tgt, lag, want }) => {
    const got = levelSamples(drv, tgt, lag);
    expect([got.xs, got.ys]).toEqual(want);
  });

  it.each(
    golden.units.diffSamples as Array<{
      drv: (number | null)[];
      tgt: (number | null)[];
      lag: number;
      want: [number[], number[]];
    }>,
  )('diffSamples(%#) — діра не перестрибується', ({ drv, tgt, lag, want }) => {
    const got = diffSamples(drv, tgt, lag);
    expect([got.xs, got.ys]).toEqual(want);
  });
});

describe('levers-core — повний аналіз проти оракула', () => {
  const res = analyzeLevers(golden.series, golden.weeksUsable);
  const want = golden.analysis;

  it('той самий підсумок: готовність, тижні, перевірено, показано', () => {
    expect(res.ready).toBe(want.ready);
    expect(res.weeks).toBe(want.weeks);
    expect(res.weeksNeeded).toBe(want.weeksNeeded);
    expect(res.tested).toBe(want.tested);
    expect(res.shown).toBe(want.shown);
  });

  it('той самий набір рядків, у тому самому порядку', () => {
    expect(res.rows.map((r) => [r.from, r.to, r.lag])).toEqual(
      want.rows.map((r: Record<string, unknown>) => [r.from, r.to, r.lag]),
    );
  });

  it('ті самі числа в кожному рядку', () => {
    res.rows.forEach((r, i) => {
      const w = want.rows[i];
      expect(near(r.rho as number, w.rho)).toBe(true);
      expect(near(r.rhoDiff as number, w.rhoDiff)).toBe(true);
      expect(near(r.p as number, w.p)).toBe(true);
      expect(r.n).toBe(w.n);
      expect(r.nDiff).toBe(w.nDiff);
    });
  });

  it('той самий читабельний ефект («12 проти 6»)', () => {
    res.rows.forEach((r, i) => {
      const e = r.effect as Record<string, number> | null;
      const w = want.rows[i].effect;
      if (!w) {
        expect(e).toBeNull();
        return;
      }
      expect(near(e!.high, w.high)).toBe(true);
      expect(near(e!.low, w.low)).toBe(true);
      expect(e!.nHigh).toBe(w.nHigh);
      expect(e!.nLow).toBe(w.nLow);
      expect(near(e!.d, w.d, 1e-3)).toBe(true);
    });
  });

  it('закладену в синтетику істину (сон -> подачі) блок таки знаходить', () => {
    expect(res.rows.some((r) => r.from === 'sleep' && r.to === 'applied' && r.lag === 1)).toBe(
      true,
    );
  });
});

describe('levers-core — порожній стан', () => {
  const early = analyzeLevers(golden.earlySeries, golden.analysisEarly.weeks as number);

  /* ⚠️ Порожній стан показується частіше за будь-який інший, і саме він мусить
     бути чесним: «потрібно ще N тижнів» ≠ «звʼязків не знайдено». Друге
     читалось би як «перевірено й нема», хоча перевірки не було. */
  it('до гейта не показує жодного рядка й каже, скільки лишилось', () => {
    expect(early.ready).toBe(false);
    expect(early.shown).toBe(0);
    expect(early.rows).toEqual([]);
    expect(early.weeksNeeded).toBe(golden.analysisEarly.weeksNeeded);
    expect(early.weeksNeeded).toBeGreaterThan(0);
  });

  it('називає ряди, які виключив, і причину — той самий перелік, що в Python', () => {
    expect(early.skipped).toEqual(golden.analysisEarly.skipped);
    expect(early.skipped.length).toBeGreaterThan(0);
  });

  it('усе одно рахує, скільки гіпотез перевірено — знаменник чесності', () => {
    expect(early.tested).toBe(golden.analysisEarly.tested);
  });
});

describe('levers-core — правило перетину (те, заради чого блок не бреше)', () => {
  // Ряд, де рівнева й різницева картини сперечаються: спільний ТРЕНД дає
  // велике додатне rho на рівнях, а тижневі коливання — дзеркальні, тож на
  // різницях rho відʼємне. Саме такий випадок і має відсіюватись.
  const n = 40;
  const drv = Array.from({ length: n }, (_, i) => i + (i % 2 ? 3 : 0));
  const tgt = Array.from({ length: n }, (_, i) => i - (i % 2 ? 3 : 0));

  it('пара, де знак рівнів і знак різниць розходяться, не показується', () => {
    const lvl = spearman(levelSamples(drv, tgt, 0).xs, levelSamples(drv, tgt, 0).ys);
    const dif = spearman(diffSamples(drv, tgt, 0).xs, diffSamples(drv, tgt, 0).ys);
    expect(lvl.rho).toBeGreaterThan(0); // передумови самого тесту
    expect(dif.rho).toBeLessThan(0);
    const res = analyzeLevers({ sleep: drv, applied: tgt }, 40, [
      { from: 'sleep', to: 'applied', lag: 0 },
    ]);
    expect(res.rows).toEqual([]);
    expect(res.tested).toBe(1);
  });

  /* ⚠️ ДВА ТЕСТИ НИЖЧЕ — ЄДИНЕ, ЩО ТРИМАЄ ПРАВИЛО ПЕРЕТИНУ.
     Золоті вектори його НЕ пінять: на тій синтетиці обидві поправки лишають
     ті самі пари, тож підміна «і» на «або» проходила б повз тести непомітно.
     А саме ця підміна повертає блок до варіанту, що бреше в 20-29% тижнів. */

  it('різниці ЗА, ефективний N ПРОТИ -> рядка немає (інакше це версія, що бреше)', () => {
    // Крок цілі = крок драйвера + повільний доданок, що довго тримає знак.
    // Малий на КРОК (різниці майже збігаються), накопичений — великий
    // (рівні розʼїжджаються). Тобто тижнева зміна виглядає повʼязаною, а
    // незалежної інформації в рівнях замало, щоб це стверджувати.
    const d = [
      2, -1, 3, -2, 1, 4, -3, 2, -1, 1, 3, -2, 2, -1, -3, 4, 1, -2, 3, -1, 2, -3, 1, 2, -1, 3, -2,
      1, -1, 2,
    ];
    const drv = [20];
    const tgt = [20];
    d.forEach((v, i) => {
      drv.push(drv[i]! + v);
      tgt.push(tgt[i]! + v + (Math.floor(i / 15) % 2 ? -1 : 1));
    });

    const lvl = levelSamples(drv, tgt, 0);
    const dif = diffSamples(drv, tgt, 0);
    const pEff = spearman(lvl.xs, lvl.ys, effN(lvl.xs, lvl.ys));
    const pDif = spearman(dif.xs, dif.ys);
    // передумови: знаки збігаються, різниці проходять, ефективний N — ні
    expect(pEff.rho * pDif.rho).toBeGreaterThan(0);
    expect(bhKeep([pDif.p])[0]).toBe(true);
    expect(bhKeep([pEff.p])[0]).toBe(false);

    const res = analyzeLevers({ sleep: drv, applied: tgt }, 40, [
      { from: 'sleep', to: 'applied', lag: 0 },
    ]);
    expect(res.tested).toBe(1);
    expect(res.rows).toEqual([]);
  });

  it('ефективний N ЗА, різниці ПРОТИ -> рядка теж немає', () => {
    // Обидва ряди строго зростають — рівні впорядковані ідеально. Але кроки
    // цілі це той самий набір, зсунутий по колу, тож тижневі ЗМІНИ між собою
    // не повʼязані: спільний порядок є, спільного руху немає.
    const steps = [
      1, 4, 2, 6, 3, 1, 5, 2, 7, 1, 3, 6, 2, 4, 1, 5, 3, 2, 6, 1, 4, 2, 5, 3, 1, 6, 2, 4, 3, 1,
    ];
    const drv = [10];
    const tgt = [10];
    steps.forEach((s, i) => {
      drv.push(drv[i]! + s);
      tgt.push(tgt[i]! + steps[(i + 2) % steps.length]!);
    });

    const lvl = levelSamples(drv, tgt, 0);
    const dif = diffSamples(drv, tgt, 0);
    const pEff = spearman(lvl.xs, lvl.ys, effN(lvl.xs, lvl.ys));
    const pDif = spearman(dif.xs, dif.ys);
    expect(pEff.rho * pDif.rho).toBeGreaterThan(0);
    expect(bhKeep([pEff.p])[0]).toBe(true);
    expect(bhKeep([pDif.p])[0]).toBe(false);

    const res = analyzeLevers({ sleep: drv, applied: tgt }, 40, [
      { from: 'sleep', to: 'applied', lag: 0 },
    ]);
    expect(res.tested).toBe(1);
    expect(res.rows).toEqual([]);
  });

  it('пара, що витримала ОБИДВІ поправки, показується', () => {
    const res = analyzeLevers(golden.series, golden.weeksUsable);
    expect(res.rows.length).toBeGreaterThan(0);
    for (const r of res.rows) {
      const drv = golden.series[r.from as string];
      const tgt = golden.series[r.to as string];
      const lvl = levelSamples(drv, tgt, r.lag as number);
      const dif = diffSamples(drv, tgt, r.lag as number);
      expect(spearman(lvl.xs, lvl.ys, effN(lvl.xs, lvl.ys)).p).toBeLessThan(LEVERS_Q);
      expect(spearman(dif.xs, dif.ys).p).toBeLessThan(LEVERS_Q);
    }
  });

  it('p рядка — ГІРШИЙ із двох поправок, не кращий', () => {
    const res = analyzeLevers(golden.series, golden.weeksUsable);
    for (const r of res.rows) {
      const drv = golden.series[r.from as string];
      const tgt = golden.series[r.to as string];
      const lvl = levelSamples(drv, tgt, r.lag as number);
      const dif = diffSamples(drv, tgt, r.lag as number);
      const pEff = spearman(lvl.xs, lvl.ys, effN(lvl.xs, lvl.ys)).p;
      const pDiff = spearman(dif.xs, dif.ys).p;
      expect(near(r.p as number, Math.round(Math.max(pEff, pDiff) * 1e6) / 1e6)).toBe(true);
      expect(r.p as number).toBeGreaterThanOrEqual(Math.min(pEff, pDiff) - 1e-9);
    }
  });
});

describe('levers-core — гейти рядів', () => {
  /* ⚠️ Саме цей гейт відповідає на заміряне: розріджений лічильник (0.7 події
     на тиждень, половина тижнів нульова) зрізає спостережуваний |rho| з 0.75
     до 0.20, тобто не показує звʼязку НІ ЗА ЯКОГО N. Мовчазне «звʼязку не
     знайдено» тут читалось би як «перевірено й нема». */
  it('розріджений лічильник виключається за домінантним нулем', () => {
    const sparse = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 3, 0, 0];
    const v = seriesUsable(sparse);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('одне значення в більшості тижнів');
  });

  it('майже стале значення виключається за кількістю різних значень', () => {
    const flat = [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1];
    expect(seriesUsable(flat).reason).toBe('майже стале значення');
  });

  it('короткий ряд виключається за довжиною, а не за варіативністю', () => {
    expect(seriesUsable([1, 2, 3, 4, 5]).reason).toBe('мало тижнів');
  });

  it('діри в ряду не рахуються за значення', () => {
    const withGaps = [
      1,
      null,
      2,
      null,
      3,
      null,
      4,
      null,
      5,
      null,
      6,
      null,
      7,
      null,
      8,
      null,
      9,
      null,
      10,
      null,
    ];
    expect(withGaps.filter((v) => v != null)).toHaveLength(10);
    expect(seriesUsable(withGaps).ok).toBe(true);
    // ті самі значення, але одне прибрано — вже мало тижнів, а не «мало різних»
    expect(seriesUsable(withGaps.slice(0, 18)).reason).toBe('мало тижнів');
  });

  it('виключений ряд знімає з розгляду ВСІ пари, де він бере участь', () => {
    const flat = new Array(30).fill(1);
    const good = Array.from({ length: 30 }, (_, i) => (i * 7) % 11);
    const res = analyzeLevers({ sleep: flat, applied: good, mock: good }, 30, [
      { from: 'sleep', to: 'applied', lag: 1 },
      { from: 'sleep', to: 'mock', lag: 1 },
    ]);
    expect(res.tested).toBe(0);
    expect(res.skipped.some((s) => s.key === 'sleep')).toBe(true);
  });
});

describe('levers-core — збір тижневих рядів зі стору', () => {
  const day = (iso: string) => iso;
  const store = {
    checkins: {
      // тиждень 2026-08-03 — три доби, придатний
      [day('2026-08-03')]: { morning: { sleepH: 7 }, evening: { dayScore: 4, flames: ['chess'] } },
      [day('2026-08-04')]: { morning: { sleepH: 8 }, evening: { dayScore: 5, flames: [] } },
      [day('2026-08-05')]: { morning: { sleepH: 6 }, evening: { dayScore: 3, flames: ['chess'] } },
      // тиждень 2026-08-10 — одна доба, НЕ придатний
      [day('2026-08-10')]: { morning: { sleepH: 9 }, evening: { dayScore: 5 } },
      // поточний тиждень (2026-08-17) — не має потрапити взагалі
      [day('2026-08-17')]: { morning: { sleepH: 5 }, evening: { dayScore: 1 } },
    },
    days: {
      [day('2026-08-03')]: { opens: 2, mock: 3, news: 1 },
      [day('2026-08-10')]: { opens: 1, mock: 0, news: 4 },
      [day('2026-08-17')]: { opens: 9, mock: 9, news: 9 },
    },
    appliedLog: [
      { url: 'a', ts: '2026-08-03' },
      { url: 'b', ts: '2026-08-06' },
      { url: 'c', ts: '2026-08-17' },
    ],
    funnelMeta: {
      a: {
        history: [
          { stage: 'applied', ts: '2026-08-03' },
          { stage: 'interview', ts: '2026-08-11' },
        ],
      },
    },
  };
  const state = {
    roadmapProgress: { 't/a': '2026-08-04T10:00:00.000Z', 't/b': '2026-08-17T10:00:00.000Z' },
  };
  const built = buildWeeklySeries(store, state, '2026-08-21', 3);

  it('поточний (неповний) тиждень у ряд не входить', () => {
    expect(built.weekStarts).toEqual(['2026-07-27', '2026-08-03', '2026-08-10']);
    expect(built.weekStarts).not.toContain('2026-08-17');
  });

  /* ⚠️ Без цього останній тиждень ряду систематично занижений (минуло 2 доби
     з 7), а систематичний зсув в останній точці — рівно те, що рангова
     кореляція прийме за сигнал. */
  it('дані поточного тижня не течуть у жоден інший кошик', () => {
    expect(built.series.applied).toEqual([0, 2, 0]);
    expect(built.series.opens).toEqual([0, 2, 1]);
    expect(built.series.roadmap).toEqual([0, 1, 0]);
  });

  it('тиждень із замалою явкою чек-іну — діра, а не нуль', () => {
    expect(built.checkinDays).toEqual([0, 3, 1]);
    expect(built.series.sleep).toEqual([null, 7, null]);
    expect(built.series.dayScore).toEqual([null, 4, null]);
    expect(built.weeksUsable).toBe(1);
  });

  it('лічильники в порожньому тижні — чесний нуль (події не було, дані є)', () => {
    expect(built.series.news).toEqual([0, 1, 4]);
    expect(built.series.funnelMoves).toEqual([0, 1, 1]);
  });

  it('вогники рахуються як кількість за вечір, невідомі значення відкидаються', () => {
    const s = buildWeeklySeries(
      {
        checkins: {
          '2026-08-03': { morning: {}, evening: { flames: ['chess', 'duolingo', 'вигадка'] } },
          '2026-08-04': { morning: {}, evening: { flames: [] } },
          '2026-08-05': { morning: {}, evening: { flames: ['chess'] } },
        },
      },
      {},
      '2026-08-21',
      2,
    );
    // Чек-іни лежать у тижні 2026-08-03 — це ПЕРШИЙ кошик із двох
    // (другий, 2026-08-10, порожній), тож [1, null], а не навпаки.
    expect(s.weekStarts).toEqual(['2026-08-03', '2026-08-10']);
    expect(s.series.flames).toEqual([1, null]); // (2 + 0 + 1) / 3, «вигадка» відкинута
  });

  it('порожній стор не падає й віддає повний набір рядів', () => {
    const s = buildWeeklySeries({}, {}, '2026-08-21', 4);
    expect(Object.keys(s.series).sort()).toEqual([...LEVER_FEATURE_KEYS].sort());
    expect(s.weeksUsable).toBe(0);
    expect(s.series.sleep).toEqual([null, null, null, null]);
    expect(s.series.applied).toEqual([0, 0, 0, 0]);
  });

  it('зібрані ряди лягають в analyzeLevers без переробки', () => {
    const res = analyzeLevers(s2.series, s2.weeksUsable);
    expect(res.ready).toBe(false);
    expect(res.weeksNeeded).toBe(GATE_WEEKS - s2.weeksUsable);
  });

  const s2 = buildWeeklySeries(store, state, '2026-08-21', 8);
});

describe('levers-core — контраст', () => {
  /* Ціль має РОЗКИД усередині кошиків — інакше pooled sd нульова, і cohensD
     свідомо віддає 0, щоб не ділити на нуль. На екран такий випадок не
     потрапляє: ціль із двох різних значень не проходить MIN_DISTINCT ще на
     seriesUsable, тобто пара навіть не рахується. */
  it('спліт по медіані драйвера, ефект рахується на ЦІЛІ', () => {
    const drv = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const tgt = [1, 2, 3, 2, 1, 3, 7, 9, 8, 7, 9, 8];
    const c = contrast(drv, tgt, 0)!;
    expect(c.high).toBe(8); // середнє цілі там, де драйвер > медіани (6.5)
    expect(c.low).toBe(2);
    expect(c.nHigh).toBe(6);
    expect(c.nLow).toBe(6);
    expect(c.d).toBeGreaterThan(3);
  });

  /* ⚠️ Медіана рахується так само, як np.median (парна довжина — середнє двох
     середніх), інакше спліт розійшовся б із оракулом там, де значення
     повторюються, — тобто рівно на дискретних шкалах. */
  it('домінантне значення драйвера тягне медіану на себе — кошик порожніє', () => {
    const drv = [1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9, 9];
    expect(contrast(drv, drv, 0)).toBeNull();
  });

  it('замалий кошик після спліту — ефекту немає, а не вигаданий', () => {
    const drv = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 9];
    expect(contrast(drv, drv, 0)).toBeNull();
  });
});
