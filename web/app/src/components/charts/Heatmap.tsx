import { useMemo, useState } from 'react';
import type { HeatmapCell } from '../../api/schema.ts';
import { useInView } from '../../lib/useInView.ts';
import { haptic } from '../../telegram.ts';

// Сітка активності в стилі GitHub contribution graph (фідбек власника):
// колонка = тиждень, рядок = день тижня, ПЛЮС обидві осі з позначками —
// ліворуч дні тижня, зверху місяці. Доти сітка була безпідписаною: видно
// «десь було густіше», але не видно КОЛИ саме.
//
// Клітинка тепер знає СКЛАД дня (o/m/n — відкриття/питання/новини), тож тап
// відповідає не лише «скільки», а «що це був за день». На тач-екрані це
// заміна hover-title, який там не працює в принципі.

function cellBg(l: number): string {
  const v = Math.max(0, Math.min(4, l)) / 4;
  const g = Math.round(150 - v * 40);
  const b = Math.round(110 - v * 28);
  const op = (0.12 + v * 0.82).toFixed(2);
  return `rgba(255,${g},${b},${op})`;
}

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const AXIS_W = 22; // місце під «Пн/Ср/Пт»
const AXIS_H = 13; // місце під підписи місяців

// Підписуємо ЧЕРЕЗ ОДИН (Пн/Ср/Пт/Нд): підписати всі сім на 11px-клітинці
// неможливо — 9px-текст злипнеться. Той самий компроміс, що в GitHub.
const DOW = ['Пн', '', 'Ср', '', 'Пт', '', 'Нд'];
const MONTHS = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

const fmtDay = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
};

export function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [tap, setTap] = useState<string | null>(null);

  const cols = useMemo(() => {
    const out: HeatmapCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  // Підпис місяця ставимо над колонкою, у якій місяць ЗМІНИВСЯ — так мітка
  // стоїть там, де місяць починається, а не по центру діапазону.
  const monthTicks = useMemo(() => {
    const ticks: { ci: number; label: string }[] = [];
    let prev = -1;
    cols.forEach((col, ci) => {
      const first = col[0];
      if (!first) return;
      const m = Number(first.d.slice(5, 7)) - 1;
      if (m !== prev) {
        // Пропускаємо мітку, що впритул до попередньої (місяць у 1 колонку).
        if (!ticks.length || ci - ticks[ticks.length - 1]!.ci >= 3) {
          ticks.push({ ci, label: MONTHS[m] ?? '' });
        }
        prev = m;
      }
    });
    return ticks;
  }, [cols]);

  const W = AXIS_W + cols.length * STEP;
  const H = AXIS_H + 7 * STEP;
  const sel = tap ? cells.find((c) => c.d === tap) : null;

  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: W, maxWidth: '100%', height: 'auto' }}
          role="img"
          aria-label="Сітка активності за 12 тижнів: колонка — тиждень, рядок — день тижня"
        >
          {monthTicks.map((t) => (
            <text
              key={`${t.ci}-${t.label}`}
              x={AXIS_W + t.ci * STEP}
              y={9}
              fontSize="8.5"
              fill="var(--color-tx3)"
              fontFamily="var(--font-mono)"
            >
              {t.label}
            </text>
          ))}
          {DOW.map((label, ri) =>
            label ? (
              <text
                key={ri}
                x={AXIS_W - 5}
                y={AXIS_H + ri * STEP + CELL - 2}
                fontSize="8.5"
                textAnchor="end"
                fill="var(--color-tx3)"
                fontFamily="var(--font-mono)"
              >
                {label}
              </text>
            ) : null,
          )}
          {cols.map((col, ci) =>
            col.map((c, ri) => (
              <rect
                key={c.d}
                x={AXIS_W + ci * STEP}
                y={AXIS_H + ri * STEP}
                width={CELL}
                height={CELL}
                rx={2.5}
                fill={cellBg(c.l)}
                stroke={tap === c.d ? 'var(--color-tx)' : 'none'}
                strokeWidth={tap === c.d ? 1.4 : 0}
                style={{
                  cursor: 'pointer',
                  // Діагональна хвиля появи: фронт іде з лівого верху вправо-вниз.
                  animation: `fadeInSoft .45s ease-out ${ci * 30 + ri * 9}ms backwards`,
                  animationPlayState: inView ? 'running' : 'paused',
                }}
                onClick={() => {
                  haptic('light');
                  setTap(tap === c.d ? null : c.d);
                }}
              />
            )),
          )}
        </svg>
      </div>

      <div className="flex items-center gap-1 text-[9px] text-tx3">
        <span>Менше</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <div
            key={l}
            className="h-[9px] w-[9px] rounded-[2.5px]"
            style={{ background: cellBg(l) }}
            aria-hidden="true"
          />
        ))}
        <span>Більше</span>
        <span className="ml-auto font-mono">
          {sel
            ? `${fmtDay(sel.d)} · ${sel.v === 0 ? 'тиша' : [sel.o && `${sel.o} відкр.`, sel.m && `${sel.m} пит.`, sel.n && `${sel.n} новин`].filter(Boolean).join(' · ')}`
            : 'тапни на день'}
        </span>
      </div>
    </div>
  );
}
