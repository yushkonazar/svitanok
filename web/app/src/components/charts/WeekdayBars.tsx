import type { HeatmapCell } from '../../api/schema.ts';
import { useInView } from '../../lib/useInView.ts';

// Агрегація s.heatmap (той самий масив, що Heatmap.tsx) по днях тижня —
// "який день найактивніший" за всю 12-тижневу історію, а не лише поточний
// тиждень (те, що вже показує WeekBars). Нуль бекенд-змін: heatmap[].d уже
// містить дату кожної клітинки, агрегація цілком на фронті.
//
// ui-ux-pro-max (--domain chart): "не лише колір" — акцентний день
// відрізняється й кольором тексту підпису, не тільки кольором стовпчика.

const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const MAX_H = 46;

// getUTCDay(): 0=Нд..6=Сб -> індекс у DOW_LABELS (0=Пн..6=Нд).
const toMonFirst = (jsDay: number) => (jsDay + 6) % 7;

export function WeekdayBars({ cells }: { cells: HeatmapCell[] }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  if (!cells.length) return null;

  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const c of cells) {
    const dow = toMonFirst(new Date(`${c.d}T00:00:00Z`).getUTCDay());
    sums[dow] += c.v;
    counts[dow]++;
  }
  const avgs = sums.map((sum, i) => (counts[i] ? sum / counts[i] : 0));
  const max = Math.max(1, ...avgs);
  const bestIdx = avgs.indexOf(Math.max(...avgs));

  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      <div className="font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
        НАЙАКТИВНІШИЙ ДЕНЬ ТИЖНЯ
      </div>
      <div className="flex h-[66px] items-end gap-2 pt-1">
        {DOW_LABELS.map((label, i) => {
          const v = avgs[i];
          const h = v > 0 ? Math.max(4, Math.round((v / max) * MAX_H)) : 3;
          const isBest = i === bestIdx && v > 0;
          return (
            <div key={label} className="flex flex-1 flex-col items-center gap-[5px]">
              <div
                className="w-full"
                style={{
                  height: h,
                  borderRadius: '6px 6px 3px 3px',
                  background: isBest
                    ? 'linear-gradient(180deg,var(--color-a2),var(--color-a1))'
                    : v > 0
                      ? 'var(--color-tx3)'
                      : 'var(--color-track)',
                  opacity: isBest ? 1 : 0.55,
                  animation: `barGrow .5s cubic-bezier(.22,1,.36,1) ${i * 45}ms backwards`,
                  animationPlayState: inView ? 'running' : 'paused',
                }}
              />
              <span
                className="font-mono text-[9px] font-medium"
                style={{ color: isBest ? 'var(--color-a2)' : 'var(--color-tx3)' }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
