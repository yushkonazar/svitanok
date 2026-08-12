import { describe, it, expect } from 'vitest';
import { buildTrendPaths } from './trendPath.ts';

/* B10/F1 (аудит C2, high): `DayShapeChart` малював ЛІНІЮ на одній шкалі, а свої
 * gridlines і точки — на іншій. Лінія брала домен [0, max(даних)] із
 * buildTrendPaths, а підписи «1/3/5» і кружечки рахувались вручну по домену
 * [1,5]. Наслідок: точки плавають над лінією, а підписи завищують значення —
 * графік, який брехав тим впевненіше, чим далі середні від 5.
 *
 * Фікс: домен можна задати ЯВНО, і тоді всі три шари (лінія, сітка, точки)
 * читають ОДИН `yOf`. Тести нижче тримають саме цей інваріант, а не форму
 * кривої: збіг координати точки з координатою лінії — це і є «графік не бреше».
 *
 * Обережно з сумісністю: решта графіків (InterestTrend, Ритм) домену не
 * передають і мусять лишитись на автоматичному [0, max] — окремий тест.
 *
 * Живе ТУТ, а не в кореневому vitest: модуль тягне d3, а d3 стоїть лише у
 * web/app — кореневий `npm ci` його не ставить, і CI падав саме на цьому. */

const OPTS = { width: 300, height: 84, padX: 8, padY: 14 };

describe('buildTrendPaths — явний домен (фікс подвійної шкали)', () => {
  it('yOf кладе межі домену рівно на межі полотна', () => {
    const { yOf } = buildTrendPaths([[1, 3, 5]], { ...OPTS, domain: [1, 5] });
    expect(yOf(5)).toBeCloseTo(OPTS.padY, 6); // верх
    expect(yOf(1)).toBeCloseTo(OPTS.height - OPTS.padY, 6); // низ
    expect(yOf(3)).toBeCloseTo((OPTS.padY + (OPTS.height - OPTS.padY)) / 2, 6); // середина
  });

  it('перша точка лінії лежить РІВНО там, куди yOf кладе її значення', () => {
    // Саме розбіжність цих двох чисел і була багом: коло малювалось по одній
    // формулі, початок path — по іншій.
    const series = [3.4, 2.8, 4.1];
    const { lineOf, yOf } = buildTrendPaths([series], { ...OPTS, domain: [1, 5] });
    const d = lineOf(series)!;
    const [, x0, y0] = /^M([\d.]+),([\d.]+)/.exec(d)!.map(Number) as unknown as [
      number,
      number,
      number,
    ];
    expect(x0).toBeCloseTo(OPTS.padX, 6);
    expect(y0).toBeCloseTo(yOf(series[0]!), 6);
  });

  it('значення поза доменом не викидає лінію за полотно (клемп)', () => {
    // Середні чек-іну завжди в [1,5], але сервер може віддати 0 (порожній слот
    // після зміни схеми) — краще притиснути до низу, ніж намалювати за межами.
    const { yOf } = buildTrendPaths([[0, 6]], { ...OPTS, domain: [1, 5] });
    expect(yOf(0)).toBeCloseTo(OPTS.height - OPTS.padY, 6);
    expect(yOf(6)).toBeCloseTo(OPTS.padY, 6);
  });
});

describe('buildTrendPaths — без домену поведінка НЕ змінилась', () => {
  it('автоматичний домен лишається [0, max] (InterestTrend/Ритм)', () => {
    const { yOf } = buildTrendPaths([[0, 40, 80]], OPTS);
    expect(yOf(80)).toBeCloseTo(OPTS.padY, 6); // максимум — угорі
    expect(yOf(0)).toBeCloseTo(OPTS.height - OPTS.padY, 6); // нуль — унизу
  });

  it('порожня/нульова серія не ділить на нуль (максимум не менший за 1)', () => {
    const { yOf } = buildTrendPaths([[0, 0]], OPTS);
    expect(Number.isFinite(yOf(0))).toBe(true);
  });

  it('null у серії лишається РОЗРИВОМ лінії, а не провалом у нуль', () => {
    const { lineOf } = buildTrendPaths([[3, null, 4]], { ...OPTS, domain: [1, 5] });
    const d = lineOf([3, null, 4])!;
    expect(d.split('M').length - 1).toBe(2); // два підшляхи = розрив
  });
});
