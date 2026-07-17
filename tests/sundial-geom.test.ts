import { describe, it, expect } from 'vitest';
import {
  CX,
  CY,
  R,
  sunGeom,
  segPath,
  readout,
  subLabel,
} from '../web/app/src/components/charts/sundial-geom.ts';

// Геометрія циферблата (фідбек власника, п.1).
//
// Що тут пиляється: доти небо ділив вшитий у CSS градієнт зі стопом на 55% — без
// жодного звʼязку зі сходом/заходом. Червневий день (16г світла) і грудневий (8г)
// малювались ОДНАКОВО. Тепер верх кола = сонячний полудень, і з цього все випливає.
//
// Справжні київські значення (50.45°N, 30.52°E).
const JUN = { sr: 4 * 60 + 46, ss: 21 * 60 + 18 }; // сонцестояння, ~16г32хв
const JUL = { sr: 5 * 60 + 6, ss: 21 * 60 + 6 }; // 17 липня, 16г00хв
const SEP = { sr: 6 * 60 + 51, ss: 19 * 60 + 10 }; // рівнодення, ~12г19хв
const DEC = { sr: 8 * 60 + 1, ss: 15 * 60 + 56 }; // сонцестояння, ~7г55хв

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe('sunGeom — чесний перетин обрію', () => {
  for (const [name, d] of Object.entries({ JUN, JUL, SEP, DEC })) {
    it(`${name}: обʼєкт перетинає обрій РІВНО о сході й заході`, () => {
      const atSr = sunGeom(d.sr, d.ss, d.sr);
      const atSs = sunGeom(d.sr, d.ss, d.ss);
      // Головний інваріант усієї фічі.
      expect(near(atSr.y, atSr.horizonY)).toBe(true);
      expect(near(atSs.y, atSs.horizonY)).toBe(true);
    });

    it(`${name}: схід ЗАВЖДИ ліворуч, захід ЗАВЖДИ праворуч`, () => {
      // Доти це збігалось рівно двічі на добу (6:00 і 18:00), хоч підписи
      // «СХІД ↑» / «ЗАХІД ↓» у WeatherBlock стоять ліворуч і праворуч завжди.
      expect(sunGeom(d.sr, d.ss, d.sr).x).toBeLessThan(CX);
      expect(sunGeom(d.sr, d.ss, d.ss).x).toBeGreaterThan(CX);
    });

    it(`${name}: за хвилину до сходу — ніч, за хвилину після заходу — ніч`, () => {
      expect(sunGeom(d.sr, d.ss, d.sr - 1).isDay).toBe(false);
      expect(sunGeom(d.sr, d.ss, d.sr + 1).isDay).toBe(true);
      expect(sunGeom(d.sr, d.ss, d.ss - 1).isDay).toBe(true);
      expect(sunGeom(d.sr, d.ss, d.ss + 1).isDay).toBe(false);
    });

    it(`${name}: у мить сходу й заходу — ЩЕ день (межі включно)`, () => {
      // «Входить у ніч лише ПІСЛЯ заходу» — формулювання власника. Зі строгим
      // порівнянням циферблат хвилину казав би «ніч, 0хв до сходу».
      expect(sunGeom(d.sr, d.ss, d.sr).isDay).toBe(true);
      expect(sunGeom(d.sr, d.ss, d.ss).isDay).toBe(true);
    });
  }

  it('частка світлого неба чесно йде за порою року', () => {
    const lit = (d: { sr: number; ss: number }) => {
      const g = sunGeom(d.sr, d.ss, 720);
      return ((g.horizonY - (CY - R)) / (2 * R)) * 100;
    };
    // Саме це й було зламано: усі чотири малювались як 55%.
    expect(lit(JUN)).toBeGreaterThan(75);
    expect(lit(SEP)).toBeGreaterThan(48);
    expect(lit(SEP)).toBeLessThan(56);
    expect(lit(DEC)).toBeLessThan(28);
    expect(lit(JUN)).toBeGreaterThan(lit(SEP));
    expect(lit(SEP)).toBeGreaterThan(lit(DEC));
  });

  it('нахил осі = переведення годинника: ~16° влітку, ~0° взимку', () => {
    const tilt = (d: { sr: number; ss: number }) =>
      ((sunGeom(d.sr, d.ss, 720).noon - 720) / 1440) * 360;
    expect(tilt(JUL)).toBeGreaterThan(14);
    expect(tilt(JUL)).toBeLessThan(18);
    expect(Math.abs(tilt(DEC))).toBeLessThan(2);
  });

  it('обʼєкт іде РІВНОМІРНО — коло рівно за добу', () => {
    // Кут — лінійний за часом, тож рівні проміжки = рівні дуги.
    const th = (m: number) => sunGeom(JUL.sr, JUL.ss, m).theta;
    const step = th(600) - th(540);
    expect(th(700) - th(640)).toBeCloseTo(step, 6);
    expect(step).toBeCloseTo((60 / 1440) * 360, 6);
  });

  it('о сонячний полудень обʼєкт РІВНО вгорі', () => {
    const g0 = sunGeom(JUL.sr, JUL.ss, 720);
    const g = sunGeom(JUL.sr, JUL.ss, g0.noon);
    expect(g.theta).toBeCloseTo(0, 6);
    expect(g.x).toBeCloseTo(CX, 6);
    expect(g.y).toBeCloseTo(CY - R, 6);
  });

  it('alt: 1 у зеніті, 0 на обрії, 1 у найглибшій ночі', () => {
    const noon = sunGeom(JUL.sr, JUL.ss, 720).noon;
    expect(sunGeom(JUL.sr, JUL.ss, noon).alt).toBeCloseTo(1, 6);
    expect(sunGeom(JUL.sr, JUL.ss, JUL.sr).alt).toBeCloseTo(0, 6);
    expect(sunGeom(JUL.sr, JUL.ss, JUL.ss).alt).toBeCloseTo(0, 6);
    // Сонячна північ = полудень + 12 год.
    expect(sunGeom(JUL.sr, JUL.ss, (noon + 720) % 1440).alt).toBeCloseTo(1, 6);
  });
});

describe('sunGeom — фолбек, коли даних немає', () => {
  it('невідомі схід/захід -> рівнодення: обрій по центру, полудень о 12:00', () => {
    // Так виглядав наївний циферблат до фікса — тепер це ЯВНИЙ фолбек.
    for (const g of [sunGeom(0, 0, 720), sunGeom(0, 1200, 720), sunGeom(500, 0, 720)]) {
      expect(g.valid).toBe(false);
      expect(g.horizonY).toBeCloseTo(CY, 6);
      expect(g.noon).toBe(720);
    }
  });

  it('биті дані (захід РАНІШЕ сходу) не ламають геометрію', () => {
    const g = sunGeom(1200, 500, 720);
    expect(g.valid).toBe(false);
    expect(Number.isFinite(g.x)).toBe(true);
    expect(Number.isFinite(g.y)).toBe(true);
    expect(Number.isFinite(g.horizonY)).toBe(true);
  });

  it('без даних відліку немає — не вигадуємо', () => {
    expect(subLabel(sunGeom(0, 0, 720), 720)).toBe('');
  });
});

describe('segPath — large-arc', () => {
  it('улітку денна дуга > 180° -> large-arc=1', () => {
    // Без прапорця SVG намалював би МЕНШУ дугу, тобто рівно навпаки:
    // довгий літній день став би куцим.
    const g = sunGeom(JUN.sr, JUN.ss, 720);
    expect(g.half * 2).toBeGreaterThan(180);
    expect(segPath(g.half, false)).toContain(`${R} ${R} 0 1 1`);
    expect(segPath(g.half, true)).toContain(`${R} ${R} 0 0 1`); // ніч — менша
  });

  it('узимку навпаки: день менший, ніч більша', () => {
    const g = sunGeom(DEC.sr, DEC.ss, 720);
    expect(g.half * 2).toBeLessThan(180);
    expect(segPath(g.half, false)).toContain(`${R} ${R} 0 0 1`);
    expect(segPath(g.half, true)).toContain(`${R} ${R} 0 1 1`);
  });

  it('кінці обох сегментів — на одній висоті (хорда горизонтальна)', () => {
    const g = sunGeom(JUL.sr, JUL.ss, 720);
    const nums = (p: string) => p.match(/-?\d+\.?\d*/g)!.map(Number);
    const day = nums(segPath(g.half, false));
    // M sx sy A R R 0 large 1 ex sy Z -> sy (idx 1) === sy кінця (idx 8)
    expect(day[1]).toBeCloseTo(day[8]!, 6);
    expect(day[1]).toBeCloseTo(g.horizonY, 6);
  });
});

describe('readout — зчитувач у половині обʼєкта', () => {
  it('звичайний день: повний розмір, блок у своїй половині', () => {
    const g = sunGeom(SEP.sr, SEP.ss, 720); // день, обрій ~по центру
    const r = readout(g);
    expect(r.scale).toBe(1);
    expect(r.clockY).toBeLessThan(g.horizonY);
  });

  it('21.06 вночі: смуга тісна -> блок стискається і НЕ лізе за обрій', () => {
    // Саме той випадок, через який жорстке правило неможливе: нічна смуга ~35px
    // при блоці ~36px. Рішення власника — стискати.
    const g = sunGeom(JUN.sr, JUN.ss, 60);
    expect(g.isDay).toBe(false);
    expect(CY + R - g.horizonY).toBeLessThan(52); // смуга справді тісна
    const r = readout(g);
    expect(r.scale).toBeLessThan(1);
    // Верх стиснутого блоку (годинник 15px -> ~7.5 вгору) нижчий за обрій.
    expect(r.clockY - 15 * r.scale * 0.5).toBeGreaterThan(g.horizonY);
    expect(r.subY).toBeLessThan(CY + R);
  });

  it('21.12 вдень: дзеркально — тісний ДЕНЬ, блок стискається', () => {
    const g = sunGeom(DEC.sr, DEC.ss, 720);
    expect(g.isDay).toBe(true);
    expect(g.horizonY - (CY - R)).toBeLessThan(52);
    const r = readout(g);
    expect(r.scale).toBeLessThan(1);
    expect(r.subY + 8.5 * r.scale * 0.5).toBeLessThan(g.horizonY);
    expect(r.clockY - 15 * r.scale * 0.5).toBeGreaterThan(CY - R);
  });

  it('блок ніколи не вилазить за коло — жодної хвилини на всіх порах року', () => {
    for (const d of [JUN, JUL, SEP, DEC]) {
      for (let m = 0; m < 1440; m += 7) {
        const g = sunGeom(d.sr, d.ss, m);
        const r = readout(g);
        // Півширина кола на висоті годинника має вміщати «21:06» (~62px при 25px).
        const dy = r.clockY - CY;
        const halfW = Math.sqrt(Math.max(0, R * R - dy * dy));
        expect(halfW * 2).toBeGreaterThan(62 * r.scale);
      }
    }
  });
});

describe('subLabel — відлік', () => {
  it('удень рахує до заходу, вночі — до сходу через північ', () => {
    // 12:00 -> захід 21:06 = 9г06хв.
    expect(subLabel(sunGeom(JUL.sr, JUL.ss, 720), 720)).toBe('ДО ЗАХОДУ 9Г 06ХВ');
    // 23:00 -> схід 5:06 наступного дня = 6г06хв (перехід через північ).
    expect(subLabel(sunGeom(JUL.sr, JUL.ss, 1380), 1380)).toBe('ДО СХОДУ 6Г 06ХВ');
  });

  it('на межах не показує відʼємний час', () => {
    // Обидві межі — ще день (див. isDay), тож обидві рахують до заходу.
    expect(subLabel(sunGeom(JUL.sr, JUL.ss, JUL.sr), JUL.sr)).toBe('ДО ЗАХОДУ 16Г 00ХВ');
    expect(subLabel(sunGeom(JUL.sr, JUL.ss, JUL.ss), JUL.ss)).toBe('ДО ЗАХОДУ 0Г 00ХВ');
    // За хвилину після заходу — вже ніч, і відлік перемикається на схід.
    expect(subLabel(sunGeom(JUL.sr, JUL.ss, JUL.ss + 1), JUL.ss + 1)).toBe('ДО СХОДУ 7Г 59ХВ');
  });
});
