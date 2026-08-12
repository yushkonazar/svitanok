import { scaleLinear } from 'd3-scale';
import { line as d3line, area as d3area, curveMonotoneX } from 'd3-shape';

// D3-математика для лінія+заливка тренд-графіків (лише координати/path-
// рядки, DOM малює React) — винесено з InterestTrend.tsx, щоб нові тренд-
// графіки (Ритм: fit%/подачі) не дублювали той самий d3-scale/d3-shape
// setup вдруге. Поведінка не змінена, лише перенесена.

export interface TrendPathOptions {
  width?: number;
  height?: number;
  padX?: number;
  padY?: number;
  /**
   * Явний y-домен [min, max] замість автоматичного [0, max(даних)].
   *
   * ⚠️ Потрібен там, де шкала ФІКСОВАНА за змістом, а не за даними: чек-ін
   * завжди 1-5, і графік мусить це показувати, навіть якщо всі середні між 2 і
   * 3. Без нього виникав баг B10: лінія малювалась по [0,max], а підписи й
   * точки — по [1,5], тобто три шари одного графіка жили на різних шкалах.
   */
  domain?: [number, number];
}

const DEFAULTS: Required<Omit<TrendPathOptions, 'domain'>> = {
  width: 300,
  height: 88,
  padX: 3,
  padY: 6,
};

/**
 * Спільний y-домен по ВСІХ переданих серіях (seriesList) — щоб кілька ліній
 * на одному графіку лишались порівнянними одна з одною (напр. фокусна тема
 * проти тьмяних фонових). `null` у серії (напр. fitWeekly — тиждень без
 * жодної подачі з fit) -> реальна ПЕРЕРВА в лінії (`.defined()`), а не
 * фальшивий провал до нуля.
 */
export function buildTrendPaths(seriesList: (number | null)[][], opts: TrendPathOptions = {}) {
  const { width, height, padX, padY } = { ...DEFAULTS, ...opts };
  const n = Math.max(2, ...seriesList.map((s) => s.length));
  const x = scaleLinear()
    .domain([0, Math.max(1, n - 1)])
    .range([padX, width - padX]);
  const flat = seriesList.flat().filter((v): v is number => v != null);
  const maxV = Math.max(1, ...flat);
  // clamp: значення поза заданим доменом притискаємо до межі полотна, а не
  // малюємо за ним (при автоматичному домені клемп ні на що не впливає — межі
  // й так виведені з даних).
  const y = scaleLinear()
    .domain(opts.domain ?? [0, maxV])
    .range([height - padY, padY])
    .clamp(true);
  const lineOf = d3line<number | null>()
    .defined((v) => v != null)
    .x((_, i) => x(i))
    .y((v) => y(v ?? 0))
    .curve(curveMonotoneX);
  const areaOf = d3area<number | null>()
    .defined((v) => v != null)
    .x((_, i) => x(i))
    .y0(y(0))
    .y1((v) => y(v ?? 0))
    .curve(curveMonotoneX);
  // yOf експортуємо НАВМИСНО: графік, який малює точки чи gridlines поруч із
  // лінією, мусить брати їхні координати ЗВІДСИ, а не рахувати власною
  // формулою — саме розбіжність двох формул і була багом B10.
  return { lineOf, areaOf, yOf: (v: number) => y(v), xOf: (i: number) => x(i) };
}
