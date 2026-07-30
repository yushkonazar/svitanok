import { useMemo, useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { shortDateFromIso } from '../../lib/dateLabel.ts';
import { haptic } from '../../telegram.ts';

// Тижнева композиція вогників (стріків у СТОРОННІХ застосунках): конструктивні
// (дуолінго/шахи) проти споживчих (тікток/снепчат/bereal).
//
// Той самий візуальний патерн, що HabitTrend (висота стовпця = утримання,
// сегменти = склад), але ОКРЕМИЙ файл, а не узагальнення HabitTrend: інший
// домен (сторонні застосунки, не сам Світанок), інші підписи й кольори —
// той самий принцип проєкту "один компонент = один інсайт" (ArchetypeRadar/
// OpenRhythm/DriversBars так само не діляться рендером один з одним).
//
// Висота стовпця = частка вечорів із БУДЬ-ЯКИМ вогником (active/days) — «чи
// тримаю звичку взагалі»; сегменти всередині — з чого вона складається.

const W = 300;
const H = 92;
const PAD_B = 16;

const PARTS = [
  { key: 'constructive' as const, label: 'конструктивні', color: 'var(--color-pos)' },
  { key: 'consumptive' as const, label: 'споживчі', color: 'var(--color-a2)' },
];

export function FlameTrend({ weeks }: { weeks: Stats['flameStats']['weekly'] }) {
  const [tap, setTap] = useState<number | null>(null);

  const rows = useMemo(
    () =>
      weeks.map((w) => {
        const total = w.constructive + w.consumptive;
        return { ...w, pct: w.days > 0 ? w.active / w.days : 0, total };
      }),
    [weeks],
  );

  if (rows.length < 2) return null;

  const barW = (W - 4) / rows.length;
  const gap = Math.min(3, barW * 0.18);
  const plotH = H - PAD_B;
  const sel = tap !== null ? rows[tap] : null;

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
          const h = Math.max(2, r.pct * (plotH - 4));
          const y = plotH - h;
          // Сегменти всередині стовпця — частки складу вогників того тижня.
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
            ? `${shortDateFromIso(sel.week)}: ${sel.active}/${sel.days} веч. · ${sel.total} вогників`
            : 'тапни на тиждень'}
        </span>
      </div>
    </div>
  );
}
