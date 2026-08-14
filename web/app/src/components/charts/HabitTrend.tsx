import { useMemo, useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { shortDateFromIso } from '../../lib/dateLabel.ts';
import { haptic } from '../../telegram.ts';
import { svgButtonProps } from '../../lib/svgButton.ts';

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

// ⚠️ ЧОМУ ПОКРИТТЯ — ОКРЕМА СМУГА, А НЕ ВИСОТА СТОВПЦЯ.
//
// Спокуса зробити висоту = active/days очевидна: блок називається «Утримання».
// Але так уже було, і власник це відхилив (a2f0345): два тижні з однаковим
// покриттям 5/5 дають ОДНАКОВУ висоту, навіть коли один — 51 дія, а другий 177.
// Відношення активних діб математично не здатне їх розрізнити.
//
// Повернути висоту на покриття означало б відновити скаргу, яку вже полікували.
// Тому обидва питання лишаються, але КОЖНЕ У СВОЇЙ ГЕОМЕТРІЇ: стовпець — обсяг
// (і його склад), смуга під ним — покриття. Різні шкали не змішуються в одному
// каналі, і жодне з двох не доводиться приносити в жертву другому.
const W = 300;
const H = 104;
const PAD_B = 16;
/** Смуга покриття під стовпцями: скільки діб тижня взагалі були активні. */
const STRIP_H = 5;
const STRIP_GAP = 5;

/** ISO-понеділок -> «03.08 – 09.08». Дата тижня без діапазону читається як ДОБА. */
function weekRange(week: string): string {
  const a = new Date(week + 'T00:00:00Z');
  const b = new Date(a);
  b.setUTCDate(b.getUTCDate() + 6);
  const f = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${f(a)} – ${f(b)}`;
}

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
  const plotH = H - PAD_B - STRIP_H - STRIP_GAP;
  const stripY = plotH + STRIP_GAP;
  const sel = tap !== null ? rows[tap] : null;
  const prev = tap !== null && tap > 0 ? rows[tap - 1] : null;
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const cover = (r: (typeof rows)[number]) => (r.days > 0 ? r.active / r.days : 0);

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
              {...svgButtonProps({
                label: `Тиждень ${weekRange(r.week)}: активних ${r.active} із ${r.days} діб; відкриттів ${r.opens}, питань ${r.mock}, новин ${r.news}`,
                pressed: tap === i,
                onActivate: () => {
                  haptic('light');
                  setTap(tap === i ? null : i);
                },
              })}
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
              {/* Смуга покриття — ДРУГЕ питання блоку у власній геометрії:
                  скільки діб тижня взагалі були активні. Доріжка малюється
                  завжди, тож порожній тиждень видно як порожню доріжку, а не
                  як відсутність елемента. */}
              <rect
                x={x}
                y={stripY}
                width={barW - gap}
                height={STRIP_H}
                rx={1.5}
                fill="var(--color-track)"
              />
              <rect
                x={x}
                y={stripY}
                width={(barW - gap) * cover(r)}
                height={STRIP_H}
                rx={1.5}
                fill="var(--color-a1)"
                opacity={tap === null || tap === i ? 1 : 0.32}
              />
              {tap === i && (
                <rect
                  x={x - 0.5}
                  y={y - 1}
                  width={barW - gap + 1}
                  height={h + 2 + STRIP_GAP + STRIP_H}
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
        {/* решта підписів осі — під SVG, у деталі тапу */}
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
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-[6px] w-[6px] rounded-[2px]"
            style={{ background: 'var(--color-a1)' }}
          />
          покриття
        </span>
      </div>

      {/* ⚠️ ДЕТАЛЬ ЗАМІСТЬ ЗВЕДЕНОГО РЯДКА. Доти тап давав
          «03.08: 7/7 діб · 212 дій» — і кожна з трьох частин була
          двозначною: «03.08» у форматі дд.мм читається як ДОБА (саме так
          він означає на теплокарті поруч), а «212 дій» зводило три різні
          лічильники в одне число, з якого не зрозуміло ні що це, ні чого
          скільки. Тепер діапазон тижня написаний повністю, а склад
          розкладено — тобто тап показує те, чого на графіку НЕ видно, а не
          переказує його. */}
      {sel ? (
        <div className="flex flex-col gap-0.5 rounded-xl border border-glassb bg-glass px-2.5 py-2">
          <div className="flex items-baseline">
            <span className="font-mono text-[10px] font-semibold text-tx2">
              {weekRange(sel.week)}
            </span>
            {prev && (
              <span
                className="ml-auto font-mono text-[9.5px]"
                style={{
                  color:
                    sel.total > prev.total
                      ? 'var(--color-pos)'
                      : sel.total < prev.total
                        ? 'var(--color-neg)'
                        : 'var(--color-tx3)',
                }}
              >
                {sel.total > prev.total ? '↑' : sel.total < prev.total ? '↓' : '→'} проти
                попереднього тижня
              </span>
            )}
          </div>
          <div className="text-[10.5px] text-tx2">
            Активних <span className="font-mono font-semibold">{sel.active}</span> із {sel.days}{' '}
            діб
            <span className="ml-1 font-mono text-tx3">
              {Math.round(cover(sel) * 100)}% покриття
            </span>
          </div>
          <div className="flex flex-wrap gap-x-2.5 font-mono text-[9.5px] text-tx3">
            {PARTS.map((p) => (
              <span key={p.key}>
                {p.label} {sel[p.key]}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="font-mono text-[9.5px] text-tx3">тапни на тиждень — покаже склад</div>
      )}
    </div>
  );
}
