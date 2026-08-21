// Геометрія добового циферблата — чиста, окремо від React (тести:
// tests/sundial-geom.test.ts). Малювання живе в SunDial.tsx.
//
// ЧОМУ ВЕРХ КОЛА — СОНЯЧНИЙ ПОЛУДЕНЬ, А НЕ 12:00
// Доти маркер їхав за годинником (полудень угорі), а небо ділив вшитий у CSS
// градієнт зі стопом на 55% — без жодного звʼязку зі сходом/заходом. Тобто
// червневий день (16г світла) і грудневий (8г) малювались ОДНАКОВО, а маркер
// перетинав «обрій» о 6:00 і 18:00 незалежно від того, де насправді сонце.
//
// Якщо покласти вгору сонячний полудень ((схід+захід)/2), усе сходиться саме:
//   • схід і захід мають ОДНАКОВИЙ y -> хорда обрію горизонтальна без підгонки;
//   • схід завжди на лівому кінці обрію, захід — на правому (як підписи поруч
//     у WeatherBlock; доти це збігалось лише двічі на добу);
//   • висота обрію = справжня частка світлового дня (21.06 — 69%, 21.12 — 33%);
//   • обʼєкт іде РІВНОМІРНО (коло за 24 год) і перетинає обрій рівно о сході
//     й заході.
// Ціна — вісь нахилена на (сонячний_полудень − 12:00). У Києві це ~16° влітку
// і ~0° взимку: різницю дає переведення годинника, і тут вона стає видимою.
//
// Чесний саме ЧАС (перетин), а не площа: висота сегмента в колі — наслідок
// геометрії, тому влітку небо світле трохи більше (75%), ніж триває день (67%).
// Мати водночас і те, й те неможливо.

export const CX = 85;
export const CY = 85;
export const R = 79;
export const SIZE = 170;

const D = Math.PI / 180;

/** Рівнодення 06:00–18:00 — фолбек, коли схід/захід невідомі (unix=0/биті). */
const FALLBACK_SR = 6 * 60;
const FALLBACK_SS = 18 * 60;

export interface Geom {
  /** Чи є справжні дані про схід/захід (інакше малюємо рівнодення). */
  valid: boolean;
  /** Схід/захід у київських хвилинах (після фолбеку). */
  sr: number;
  ss: number;
  /** Сонячний полудень, хвилини. Верх кола. */
  noon: number;
  /** Довжина світлового дня, хвилини. */
  dayMin: number;
  /** Півдуги дня, градуси (кут від верху до сходу/заходу). */
  half: number;
  /** Кут обʼєкта від верху за годинниковою, (−180, 180]. */
  theta: number;
  /** Позиція обʼєкта. */
  x: number;
  y: number;
  /** y горизонтальної хорди обрію. */
  horizonY: number;
  /** Півширина обрію (від центра до краю кола на висоті хорди). */
  horizonHalfW: number;
  isDay: boolean;
  /** 0..1 — висота над обрієм удень / глибина під ним уночі. Драйвер кольору. */
  alt: number;
}

/**
 * @param srMin схід у київських хвилинах (0 = невідомо)
 * @param ssMin захід у київських хвилинах (0 = невідомо)
 * @param nowMin поточний київський час у хвилинах
 */
export function sunGeom(srMin: number, ssMin: number, nowMin: number): Geom {
  const valid = srMin > 0 && ssMin > 0 && ssMin > srMin;
  const sr = valid ? srMin : FALLBACK_SR;
  const ss = valid ? ssMin : FALLBACK_SS;

  const noon = (sr + ss) / 2;
  const dayMin = ss - sr;
  const half = ((dayMin / 1440) * 360) / 2;

  // Кут від ВЕРХУ за годинниковою стрілкою; нормалізуємо в (−180, 180], щоб
  // |theta| < half читалось як «день» без окремих випадків біля півночі.
  let theta = ((nowMin - noon) / 1440) * 360;
  theta = (((theta % 360) + 540) % 360) - 180;

  const x = CX + R * Math.sin(theta * D);
  const y = CY - R * Math.cos(theta * D);
  const horizonY = CY - R * Math.cos(half * D);
  const horizonHalfW = R * Math.sin(half * D);
  // Межі ВКЛЮЧНО — «входить у ніч лише ПІСЛЯ заходу» (формулювання власника) і
  // так само в старому коді (mins >= sr && mins <= ss). Зі строгим `<` мить
  // сходу рахувалась би ніччю, і циферблат хвилину казав би «ніч, 0хв до сходу».
  //
  // ⚠️ EPS обовʼязковий, і це не перестраховка. theta й half рахуються різними
  // шляхами з тих самих чисел, тож на самій межі розходяться в останньому біті:
  // на рівноденні |theta|=92.375, а half=92.37499999999999 — голе `<=` дає
  // false. Три дати з чотирьох проходять ВИПАДКОВО (їхні числа лягли в double
  // точно), рівнодення — ні. 1e-9° = 4e-9 хвилини, тобто фізично нуль.
  const EPS = 1e-9;
  const isDay = Math.abs(theta) <= half + EPS;

  // Нормована висота: 1 у зеніті / найглибшій ночі, 0 на обрії.
  const c = Math.cos(theta * D);
  const ch = Math.cos(half * D);
  const denom = isDay ? 1 - ch : ch + 1;
  const alt = denom < 1e-6 ? 1 : (isDay ? c - ch : ch - c) / denom;

  return { valid, sr, ss, noon, dayMin, half, theta, x, y, horizonY, horizonHalfW, isDay, alt };
}

/**
 * Сегмент неба як SVG-path: від сходу до заходу через ВЕРХ (день) або через НИЗ
 * (ніч). large-arc обовʼязковий: улітку денна дуга > 180°, і без прапорця SVG
 * намалював би меншу дугу — тобто рівно навпаки.
 */
export function segPath(half: number, night: boolean): string {
  const sx = CX - R * Math.sin(half * D);
  const sy = CY - R * Math.cos(half * D);
  const ex = CX + R * Math.sin(half * D);
  const arc = night ? 360 - half * 2 : half * 2;
  const large = arc > 180 ? 1 : 0;
  return night
    ? `M ${ex} ${sy} A ${R} ${R} 0 ${large} 1 ${sx} ${sy} Z`
    : `M ${sx} ${sy} A ${R} ${R} 0 ${large} 1 ${ex} ${sy} Z`;
}

export interface Readout {
  clockY: number;
  subY: number;
  /** Множник шрифта (1 = звичайний, <1 — тісна половина). */
  scale: number;
}

/** Блок «час + відлік» ≈ 36px заввишки; ширший за хорду при |dy| > 51. */
const TEXT_MIN_Y = 34;
const TEXT_MAX_Y = 136;
/** Нижче цієї висоти половина вважається тісною й блок стискається. */
const TIGHT_H = 52;
const TIGHT_SCALE = 0.6;

/**
 * Де живе зчитувач: у половині обʼєкта (рішення власника).
 *
 * ⚠️ Жорстке «завжди у своїй половині» НЕЗДІЙСНЕННЕ на сонцестояннях: 21.06
 * нічна смуга — ~35px при блоці ~36px, і щоб він там центрувався, потрібне
 * R≥113 (диск 226px), якого макет не дасть — обабіч живуть підписи сходу/заходу.
 * Тому в тісній половині блок СТИСКАЄТЬСЯ (обрано власником із трьох варіантів):
 * кілька тижнів на рік цифри дрібніші, зате завжди по свій бік обрію.
 */
export function readout(g: Geom): Readout {
  const top = g.isDay ? CY - R : g.horizonY;
  const bot = g.isDay ? g.horizonY : CY + R;
  const mid = (top + bot) / 2;

  if (bot - top < TIGHT_H) return { clockY: mid - 4, subY: mid + 9, scale: TIGHT_SCALE };

  const y = Math.min(TEXT_MAX_Y, Math.max(TEXT_MIN_Y, mid));
  return { clockY: y, subY: y + 17, scale: 1 };
}

/** Відлік до найближчої події: удень — до заходу, вночі — до сходу. */
export function subLabel(g: Geom, nowMin: number): string {
  if (!g.valid) return '';
  const left = g.isDay ? g.ss - nowMin : (g.sr - nowMin + 1440) % 1440;
  const m = Math.max(0, Math.round(left));
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return g.isDay ? `ДО ЗАХОДУ ${h}Г ${mm}ХВ` : `ДО СХОДУ ${h}Г ${mm}ХВ`;
}
