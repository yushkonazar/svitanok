import { useMemo } from 'react';
import type { CheckinPoint } from '../../api/schema.ts';
import { buildTrendPaths } from '../../lib/trendPath.ts';

// Форма дня: середні енергія/настрій по трьох зрізах доби (ранок/післяобід/
// вечір) за ВСЮ історію ряду, а не одне число «середня енергія». Дані вже
// рахуються на бекенді (checkinSeries[].energyCurve/moodCurve) — доти
// зберігались і ніде не показувались (checkinSeries споживався лише через
// .length і .sleepH). D3 — лише координати (buildTrendPaths, той самий
// хелпер, що InterestTrend), DOM малює React.

const W = 300;
const H = 84;
const SLOT_LABEL = ['ранок', 'післяобід', 'вечір'];

/** Три поділки: низ, середина, верх поточного домену. */
function gridTicks([lo, hi]: [number, number]): number[] {
  const mid = (lo + hi) / 2;
  return [lo, mid, hi].map((v) => Math.round(v * 10) / 10);
}

/** Значення по трьох слотах, розкладені в кошики. */
function bucketsOf(series: CheckinPoint[], key: 'energyCurve' | 'moodCurve'): number[][] {
  const out: number[][] = [[], [], []];
  for (const p of series) {
    const curve = p[key];
    for (let i = 0; i < 3; i++) {
      const v = curve[i];
      if (typeof v === 'number') out[i]!.push(v);
    }
  }
  return out;
}

const avg = (xs: number[]) =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;

/** Квантиль лінійною інтерполяцією — той самий метод, що percentile у stats-core. */
function q(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo]! : a[lo]! + (a[hi]! - a[lo]!) * (i - lo);
}

/** Смуга q1..q3 як замкнутий контур: верх зліва направо, низ назад. */
function bandPath(
  q1: (number | null)[],
  q3: (number | null)[],
  xOf: (i: number) => number,
  yOf: (v: number) => number,
): string | null {
  const idx = [0, 1, 2].filter((i) => q1[i] !== null && q3[i] !== null);
  if (idx.length < 2) return null;
  const top = idx.map((i) => `${xOf(i)},${yOf(q3[i]!)}`);
  const bottom = [...idx].reverse().map((i) => `${xOf(i)},${yOf(q1[i]!)}`);
  return `M${top.join('L')}L${bottom.join('L')}Z`;
}

export function DayShapeChart({ series }: { series: CheckinPoint[] }) {
  const eB = useMemo(() => bucketsOf(series, 'energyCurve'), [series]);
  const mB = useMemo(() => bucketsOf(series, 'moodCurve'), [series]);
  const energy = useMemo(() => eB.map(avg), [eB]);
  const mood = useMemo(() => mB.map(avg), [mB]);
  // ⚠️ РОЗКИД, а не лише середнє. Дві криві «показують майже одне й те ж»
  // (фідбек власника) не тому, що рахуються з одного джерела — energy й mood
  // це окремі поля, — а тому що середнє за 30 діб з'їдає саме ту варіативність,
  // заради якої на графік і дивишся. Стрічка q1..q3 повертає її: видно не «мій
  // день такий», а «мій день ЗАЗВИЧАЙ такий, але буває по-різному».
  const eQ1 = useMemo(() => eB.map((b) => q(b, 0.25)), [eB]);
  const eQ3 = useMemo(() => eB.map((b) => q(b, 0.75)), [eB]);
  const n = series.length;

  // ⚠️ Домен ЗАДАНО ЯВНО (B10). Шкала чек-іну фіксована за змістом — 1-5, — а
  // не виведена з даних: без цього лінія жила на [0, max(середніх)], а підписи
  // «1/3/5» і кружечки рахувались по [1,5], тобто три шари одного графіка
  // стояли на різних шкалах. Точки плавали над лінією, а сітка завищувала
  // значення тим сильніше, чим далі середні від 5.
  // ⚠️ ДОМЕН АВТОМАСШТАБНИЙ, але з мінімальним діапазоном і спільний на ВСІ
  // шари. Фіксований [1,5] був правильним виправленням B10 (три шари графіка
  // стояли на різних шкалах), але ціна виявилась висока: реальний розкид
  // середніх — приблизно 2.8-3.6, тобто вся інформація тулилась у 20% висоти,
  // і криві виглядали однаковими просто тому, що їм не було де розійтися.
  //
  // MIN_SPAN тримає рівно ту гарантію, заради якої ставили [1,5]: на дуже
  // рівних даних графік не роздує шум до вигляду драми. Домен рахується з
  // УСІХ шарів разом (середні + межі стрічки), тож інваріант B10 — одна шкала
  // на всі три шари — лишається за побудовою, а не за уважністю.
  const domain = useMemo<[number, number]>(() => {
    const vals = [...energy, ...mood, ...eQ1, ...eQ3].filter((v): v is number => v !== null);
    if (!vals.length) return [1, 5];
    const MIN_SPAN = 1.5;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max(0, (MIN_SPAN - (hi - lo)) / 2);
    lo = Math.max(1, lo - pad - 0.15);
    hi = Math.min(5, hi + pad + 0.15);
    return lo < hi ? [lo, hi] : [1, 5];
  }, [energy, mood, eQ1, eQ3]);

  const { lineOf, yOf, xOf } = useMemo(
    () =>
      buildTrendPaths([energy, mood], {
        width: W,
        height: H,
        padX: 8,
        padY: 14,
        domain,
      }),
    [energy, mood, domain],
  );

  const hasEnergy = energy.some((v) => v !== null);
  const hasMood = mood.some((v) => v !== null);
  if (!hasEnergy && !hasMood) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {/* Сітка — з ДОМЕНУ, не з літералів [1,3,5]: інакше при автомасштабі
            підписи опинилися б поза полем або злиплись, тобто повернувся б
            рівно той дефект B10, від якого фіксований домен і рятував. */}
        {gridTicks(domain).map((v) => {
          const y = yOf(v);
          return (
            <g key={v}>
              <line x1={8} x2={W - 8} y1={y} y2={y} stroke="var(--color-hair)" strokeWidth="1" />
              <text
                x={0}
                y={y + 3}
                fontSize="8"
                fill="var(--color-tx3)"
                fontFamily="var(--font-mono)"
              >
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </text>
            </g>
          );
        })}
        {/* Стрічка під лініями: контекст не має перекривати сам сигнал. */}
        {(() => {
          const d = bandPath(eQ1, eQ3, xOf, yOf);
          return d ? <path d={d} fill="var(--color-a2)" opacity={0.14} /> : null;
        })()}
        {hasMood && (
          <path
            d={lineOf(mood) ?? undefined}
            fill="none"
            stroke="var(--color-tx3)"
            strokeWidth="1.6"
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
        )}
        {hasEnergy && (
          <path
            d={lineOf(energy) ?? undefined}
            fill="none"
            stroke="var(--color-a2)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}
        {hasEnergy &&
          energy.map(
            (v, i) =>
              v !== null && (
                <circle key={i} cx={xOf(i)} cy={yOf(v)} r={2.6} fill="var(--color-a2)" />
              ),
          )}
        {SLOT_LABEL.map((lbl, i) => (
          <text
            key={lbl}
            x={xOf(i)}
            y={H - 2}
            fontSize="9"
            textAnchor="middle"
            fill="var(--color-tx3)"
          >
            {lbl}
          </text>
        ))}
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-tx3">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-[2px] w-3 rounded-full"
            style={{ background: 'var(--color-a2)' }}
          />
          енергія
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-[2px] w-3 rounded-full"
            style={{ background: 'var(--color-tx3)', opacity: 0.7 }}
          />
          настрій
        </span>
        <span className="ml-auto font-mono">{n} діб</span>
      </div>
    </div>
  );
}
