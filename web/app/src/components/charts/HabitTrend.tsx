import { useMemo, useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { shortDateFromIso } from '../../lib/dateLabel.ts';
import { haptic } from '../../telegram.ts';

// Утримання по тижнях: скільки дій зробив за тиждень (відносно найактивнішого
// з показаних), і З ЧОГО складалась активність (відкриття / питання / новини).
//
// ⚠️ Регресія (фідбек власника): висота раніше кодувала % активних діб тижня
// (active/days). Але два тижні з ОДНАКОВИМ покриттям (напр. 5/5 діб) дають
// ОДНАКОВУ висоту, навіть якщо один — 51 дія, а другий — 177: ratio активних
// діб математично не може розрізнити ці тижні (обидва =1.0), тож різниця в
// обсязі була невидимою саме там, де на неї тапали подивитись. Тепер висота =
// обсяг дій відносно найактивнішого тижня вікна; покриття (active/days) і
// далі показується в деталі під графіком і в бейджі «Утримання» вище (той
// рахує окремо, з самого habitWeekly, а не з висоти стовпця).
//
// Сегменти всередині стовпця лишаються складом активності (частки
// opens/mock/news) — стек тут коректний: три категорії (ui-ux-pro-max:
// part-to-whole ≤5, stacked bar — рекомендований варіант; pie/donut має
// grade C і відпадає).

const W = 300;
const H = 92;
const PAD_B = 16;

const PARTS = [
  { key: 'opens' as const, label: 'відкриття', color: 'var(--color-a2)' },
  { key: 'mock' as const, label: 'питання', color: 'var(--color-idx-agency)' },
  { key: 'news' as const, label: 'новини', color: 'var(--color-idx-recovery)' },
];

export function HabitTrend({ weeks }: { weeks: Stats['habitWeekly'] }) {
  const [tap, setTap] = useState<number | null>(null);

  const rows = useMemo(
    () =>
      weeks.map((w) => ({
        ...w,
        total: w.opens + w.mock + w.news,
      })),
    [weeks],
  );

  if (rows.length < 2) return null;

  const barW = (W - 4) / rows.length;
  const gap = Math.min(3, barW * 0.18);
  const plotH = H - PAD_B;
  const sel = tap !== null ? rows[tap] : null;
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div className="flex flex-col gap-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {[0.5, 1].map((g) => (
          <line
            key={g}
            x1={0}
            x2={W}
            y1={plotH - g * (plotH - 4)}
            y2={plotH - g * (plotH - 4)}
            stroke="var(--color-hair)"
            strokeWidth="1"
          />
        ))}
        {rows.map((r, i) => {
          const x = 2 + i * barW;
          const h = Math.max(2, (r.total / maxTotal) * (plotH - 4));
          const y = plotH - h;
          // Сегменти всередині стовпця — частки складу активності.
          let acc = 0;
          return (
            <g
              key={r.week}
              onClick={() => {
                haptic('light');
                setTap(tap === i ? null : i);
              }}
              style={{ cursor: 'pointer' }}
            >
              {/* прозорий хіт-таргет на всю висоту: тонкий стовпчик важко влучити */}
              <rect x={x} y={0} width={barW} height={plotH} fill="transparent" />
              {r.total === 0 ? (
                <rect x={x} y={y} width={barW - gap} height={h} rx={2} fill="var(--color-track)" />
              ) : (
                PARTS.map((p) => {
                  const frac = r[p.key] / r.total;
                  const segH = frac * h;
                  const segY = y + acc;
                  acc += segH;
                  return segH < 0.5 ? null : (
                    <rect
                      key={p.key}
                      x={x}
                      y={segY}
                      width={barW - gap}
                      height={segH}
                      fill={p.color}
                      opacity={tap === null || tap === i ? 1 : 0.32}
                    />
                  );
                })
              )}
              {tap === i && (
                <rect
                  x={x - 0.5}
                  y={y - 1}
                  width={barW - gap + 1}
                  height={h + 2}
                  rx={2}
                  fill="none"
                  stroke="var(--color-tx)"
                  strokeWidth="1"
                />
              )}
            </g>
          );
        })}
        <text x={0} y={H - 3} fontSize="9" fill="var(--color-tx3)" fontFamily="var(--font-mono)">
          {shortDateFromIso(rows[0]!.week)}
        </text>
        <text
          x={W}
          y={H - 3}
          fontSize="9"
          textAnchor="end"
          fill="var(--color-tx3)"
          fontFamily="var(--font-mono)"
        >
          {shortDateFromIso(rows[rows.length - 1]!.week)}
        </text>
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9.5px] text-tx3">
        {PARTS.map((p) => (
          <span key={p.key} className="flex items-center gap-1">
            <span
              className="inline-block h-[6px] w-[6px] rounded-[2px]"
              style={{ background: p.color }}
            />
            {p.label}
          </span>
        ))}
        <span className="ml-auto font-mono">
          {sel
            ? `${shortDateFromIso(sel.week)}: ${sel.active}/${sel.days} діб · ${sel.total} дій`
            : 'тапни на тиждень'}
        </span>
      </div>
    </div>
  );
}
