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
}

const DEFAULTS: Required<TrendPathOptions> = { width: 300, height: 88, padX: 3, padY: 6 };

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
  const y = scaleLinear().domain([0, maxV]).range([height - padY, padY]);
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
  return { lineOf, areaOf };
}
