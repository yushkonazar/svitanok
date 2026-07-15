import type { HeatmapCell } from '../../api/schema.ts';

// Теплокарта активності (роадмеп v3, E1) — 1:1 з index.html:1617-1635 + CSS.
// Колонка = тиждень, зверху вниз Пн→Нд. Клітинки 11×11, radius 3, gap 3.

const DAY_LABELS = ['Пн', '', 'Ср', '', 'Пт', '', 'Нд'];

// Рівні: коралові альфи (читабельні в обох темах), l0 — тема-залежний трек.
const LEVEL_BG: Record<number, string> = {
  0: 'var(--color-track)',
  1: 'rgba(255,122,89,0.28)',
  2: 'rgba(255,122,89,0.5)',
  3: 'rgba(255,140,70,0.75)',
  4: 'linear-gradient(135deg,#ff6b57,#ffb03a)',
};

function cell(bg: string, title?: string) {
  return (
    <span
      title={title}
      style={{ width: 11, height: 11, borderRadius: 3, background: bg }}
      className="block"
    />
  );
}

export function HeatmapGrid({ cells }: { cells: HeatmapCell[] }) {
  const cols: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

  return (
    <div className="overflow-x-auto">
      <div className="flex" style={{ gap: 3 }}>
        <div className="flex flex-col" style={{ gap: 3 }}>
          {DAY_LABELS.map((l, i) => (
            <span key={i} className="text-[9px] leading-none text-muted" style={{ height: 11 }}>
              {l}
            </span>
          ))}
        </div>
        {cols.map((col, ci) => (
          <div key={ci} className="flex flex-col" style={{ gap: 3 }}>
            {col.map((c) => (
              <span key={c.d}>{cell(LEVEL_BG[c.l] ?? LEVEL_BG[0], `${c.d}: ${c.v}`)}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
