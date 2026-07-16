import type { HeatmapCell } from '../../api/schema.ts';

// Теплокарта активності (дизайн v2, Svitanok.dc.html): колонка = тиждень,
// зверху вниз Пн→Нд; клітинки — коралові відтінки за інтенсивністю.
// Рівень l (0..4) із stats-core → v (0..1) → колір за формулою макета.

function cellBg(l: number): string {
  const v = Math.max(0, Math.min(4, l)) / 4;
  const g = Math.round(150 - v * 40);
  const b = Math.round(110 - v * 28);
  const op = (0.12 + v * 0.82).toFixed(2);
  return `rgba(255,${g},${b},${op})`;
}

export function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  const cols: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

  // Колонки НЕ розтягуємо (без flex-1) — у макеті теплокарта компактна,
  // клітинка 9px, ліворуч; решта ширини лишається повітрям.
  return (
    <div className="flex gap-[3px]">
      {cols.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-[3px]">
          {col.map((c) => (
            <div
              key={c.d}
              title={`${c.d}: ${c.v}`}
              className="w-[9px] rounded-[2.5px]"
              style={{ aspectRatio: '1', background: cellBg(c.l) }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
