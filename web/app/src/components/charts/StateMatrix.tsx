import { useMemo, useState } from 'react';
import type { CheckinRaw } from '../../api/schema.ts';
import { haptic } from '../../telegram.ts';
import {
  readingsOf,
  gridOf,
  cellDetail,
  SLOT_FILTERS,
  CAUSE_MIN_N,
  type SlotFilter,
} from '../../lib/stateMap.ts';
import { pluralUk } from '../../lib/plural.ts';
import { Segmented } from '../ui/Segmented.tsx';

// Карта станів: енергія × настрій, 5×5 клітинок. Геометрія НАВМИСНО повторює
// AffectPad (введення чек-іну, той самий 5×5): тапаєш по сітці — бачиш свої
// доби на ТІЙ САМІЙ сітці.
//
// ⚠️ ЧОМУ ДЖЕРЕЛО — checkinRaw, а не checkinSeries, як було. Дві причини, і
// обидві про чесність:
//   1. СЛОТ. Ряд віддавав energyCurve/moodCurve, і сітка зсипала ранок, день
//      та вечір в одну купу. «Енергія 2 · настрій 2» вранці (недоспав) і
//      ввечері (виснажився за день) — різні явища з різними причинами, а
//      клітинка була одна. Тепер слот видно й ним можна фільтрувати.
//   2. ГЛИБИНА. Ряд — 30 діб, тобто ≤90 зрізів на 25 клітинок. Підказка при
//      цьому обіцяла показати, «де ти буваєш насправді». Гаряче вікно дає 90
//      діб, і глибина тепер ПІДПИСАНА, а не мається на увазі.
//
// ui-ux-pro-max (--domain chart): Heatmap/Matrix вимагає ≥20 клітинок і ЧИСЛО
// на клітинці, не лише колір (accessibility — «color only» high severity) —
// обидва дотримані.

/** Нижче цього сітка виглядає як помилка рендера, а не як розподіл. */
const MIN_READINGS = 12;

export function StateMatrix({ raw }: { raw: CheckinRaw }) {
  const [slot, setSlot] = useState<SlotFilter>('all');
  const [tap, setTap] = useState<string | null>(null);

  const readings = useMemo(() => readingsOf(raw, slot), [raw, slot]);
  const { grid, max, n } = useMemo(() => gridOf(readings), [readings]);
  // Гейт рахуємо по ВСІХ зрізах, а не по відфільтрованих: інакше перемикач
  // слоту зникав би разом із сіткою, і повернутись до «Усі» було б нічим.
  const total = useMemo(() => readingsOf(raw, 'all').length, [raw]);
  if (total < MIN_READINGS) return null;

  const cell = 34;
  const gap = 3;
  const gx = 22;
  const gy = 4;
  const W = gx + 5 * cell + 4 * gap;
  const H = gy + 5 * cell + 4 * gap + 16;
  const tapped = tap ? { r: Number(tap.split(':')[0]), c: Number(tap.split(':')[1]) } : null;
  const tappedCount = tapped ? grid[tapped.r]![tapped.c]! : 0;

  const colorFor = (v: number) => {
    if (v === 0) return 'var(--color-track)';
    const t = v / max;
    // Той самий accent-градієнт, що решта дашборда (a1->a2), лише як
    // intensity-шкала: не додаємо третій незалежний колір у палітру.
    return `color-mix(in srgb, var(--color-a2) ${Math.round(18 + t * 62)}%, var(--color-track))`;
  };

  return (
    <div className="flex flex-col gap-2">
      <Segmented
        segments={SLOT_FILTERS}
        value={slot}
        onChange={(id) => {
          haptic('light');
          setSlot(id);
          setTap(null); // вибір клітинки належав попередньому зрізу даних
        }}
      />

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {[5, 4, 3, 2, 1].map((v, r) => (
          <text
            key={v}
            x={gx - 6}
            y={gy + r * (cell + gap) + cell / 2 + 3}
            fontSize="9"
            textAnchor="end"
            fill="var(--color-tx3)"
            fontFamily="var(--font-mono)"
          >
            {v}
          </text>
        ))}
        {[1, 2, 3, 4, 5].map((v, c) => (
          <text
            key={v}
            x={gx + c * (cell + gap) + cell / 2}
            y={gy + 5 * (cell + gap) - gap + 10}
            fontSize="9"
            textAnchor="middle"
            fill="var(--color-tx3)"
            fontFamily="var(--font-mono)"
          >
            {v}
          </text>
        ))}
        {grid.map((row, r) =>
          row.map((v, c) => {
            const key = `${r}:${c}`;
            const x = gx + c * (cell + gap);
            const y = gy + r * (cell + gap);
            return (
              <g
                key={key}
                onClick={() => {
                  haptic('light');
                  setTap(tap === key ? null : key);
                }}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  x={x}
                  y={y}
                  width={cell}
                  height={cell}
                  rx={7}
                  fill={colorFor(v)}
                  stroke={tap === key ? 'var(--color-a2)' : 'var(--color-glassb)'}
                  strokeWidth={tap === key ? 1.6 : 1}
                />
                {v > 0 && (
                  <text
                    x={x + cell / 2}
                    y={y + cell / 2 + 4}
                    fontSize="12"
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontWeight={600}
                    fill={v / max > 0.55 ? 'var(--color-onacc)' : 'var(--color-tx2)'}
                  >
                    {v}
                  </text>
                )}
              </g>
            );
          }),
        )}
      </svg>

      <div className="flex items-center justify-between text-[9.5px] text-tx3">
        <span>енергія ↑ · настрій →</span>
        <span className="font-mono">
          {tapped
            ? `енергія ${5 - tapped.r} · настрій ${tapped.c + 1} — ${tappedCount}×`
            : `${n} ${pluralUk(n, ['зріз', 'зрізи', 'зрізів'])}`}
        </span>
      </div>

      {tapped && (
        <CellPanel
          raw={raw}
          filter={slot}
          energy={5 - tapped.r}
          mood={tapped.c + 1}
        />
      )}
    </div>
  );
}

const SLOT_WORD: Record<SlotFilter, [string, string, string]> = {
  all: ['зріз', 'зрізи', 'зрізів'],
  morning: ['ранок', 'ранки', 'ранків'],
  afternoon: ['день', 'дні', 'днів'],
  evening: ['вечір', 'вечори', 'вечорів'],
};

/** «03.08» — той самий формат, що в тултіпі Heatmap. */
const fmtDay = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
};

/** Скільки дат показуємо списком, доки він читається як список, а не як стіна. */
const MAX_DATES = 12;

/**
 * Деталі клітинки — ІНЛАЙН під сіткою, не аркушем.
 *
 * Аркуш накрив би саму сітку, а тут важливо бачити одночасно й де ти тапнув,
 * і що це означає: без клітинки перед очима «7 вечорів» втрачає прив'язку.
 */
function CellPanel({
  raw,
  filter,
  energy,
  mood,
}: {
  raw: CheckinRaw;
  filter: SlotFilter;
  energy: number;
  mood: number;
}) {
  const detail = useMemo(
    () => cellDetail(raw, filter, { energy, mood }),
    [raw, filter, energy, mood],
  );
  const { readings, causes, scope, dayScore } = detail;

  if (!readings.length) {
    return (
      <div className="rounded-xl border border-glassb bg-glass p-3 text-[11px] leading-[1.5] text-tx3">
        У цьому стані ти не був жодного разу за {raw.days} діб.
      </div>
    );
  }

  const word = pluralUk(readings.length, SLOT_WORD[filter]);
  const shown = readings.slice(-MAX_DATES).reverse();
  const hidden = readings.length - shown.length;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-glassb bg-glass p-3">
      <div className="text-[11.5px] font-semibold">
        {readings.length} {word}
        <span className="ml-1.5 font-mono text-[10px] font-normal text-tx3">
          енергія {energy} · настрій {mood}
        </span>
      </div>

      {/* Дати — ЗАВЖДИ, за будь-якої вибірки: це факт, а не висновок, і саме
          з них починається «а, точно, то був той тиждень». */}
      <div className="flex flex-wrap gap-1">
        {shown.map((r) => (
          <span
            key={`${r.d}-${r.slot}`}
            className="rounded-md border border-glassb px-1.5 py-0.5 font-mono text-[10px] text-tx2"
          >
            {fmtDay(r.d)}
          </span>
        ))}
        {hidden > 0 && <span className="self-center font-mono text-[10px] text-tx3">+{hidden}</span>}
      </div>

      {dayScore && (
        <div className="flex items-baseline gap-1.5 border-t border-glassb pt-2 text-[11.5px]">
          <span className="text-tx2">Оцінка таких днів</span>
          <span
            className="font-mono font-semibold"
            style={{
              color:
                dayScore.avg > dayScore.base
                  ? 'var(--color-pos)'
                  : dayScore.avg < dayScore.base
                    ? 'var(--color-neg)'
                    : undefined,
            }}
          >
            {dayScore.avg}
          </span>
          <span className="ml-auto font-mono text-[10px] text-tx3">
            зазвичай {dayScore.base}
          </span>
        </div>
      )}

      {causes.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-glassb pt-2">
          <div className="text-[10.5px] font-semibold text-tx2">
            {scope === 'zone' ? 'Що поруч зі схожими станами' : 'Що було поруч'}
            <span className="ml-1 font-mono text-[9.5px] font-normal text-tx3">
              проти решти · {detail.n} зр.
            </span>
          </div>
          {/* ⚠️ ПОКАЗУЄМО ДВІ ЧАСТКИ, А НЕ КРАТНІСТЬ. Спокуса написати «×2.1
              частіше» велика, але на чистому розділенні (усі 17 із втомою,
              решта — жодного разу) та сама формула дає «×70», і це вже не
              висновок, а фальшива точність: число, що коливається вдесятеро
              від однієї нової доби. `n/of` проти «норми» читається одразу й
              зіпсуватись не може. Кратність лишається — але лише всередині,
              як міра для сортування й порогу. */}
          {causes.map((c) => (
            <div key={c.key} className="flex items-baseline gap-2 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-tx2">{c.label}</span>
              <span
                className="flex-none font-mono text-[10.5px] font-semibold"
                style={{ color: c.lift > 1 ? 'var(--color-neg)' : 'var(--color-pos)' }}
              >
                {c.lift > 1 ? '↑' : '↓'} {c.n}/{c.of}
              </span>
              <span className="w-[62px] flex-none text-right font-mono text-[10px] text-tx3">
                норма {Math.round(c.baseShare * 100)}%
              </span>
            </div>
          ))}
          {scope === 'zone' && (
            <div className="text-[9.5px] leading-[1.45] text-tx3">
              У самій клітинці ще замало зрізів для порівняння, тож пораховано по сусідніх
              станах. Це чесніше, ніж робити висновок із {readings.length}.
            </div>
          )}
        </div>
      ) : (
        <div className="border-t border-glassb pt-2 text-[10px] leading-[1.45] text-tx3">
          Замало даних, щоб порівнювати причини — потрібно щонайменше {CAUSE_MIN_N} зрізів у
          цьому стані або поруч із ним. Дати вище вже точні.
        </div>
      )}
    </div>
  );
}
