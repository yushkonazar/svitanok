import type { HeatmapCell } from '../../api/schema.ts';
import { useInView } from '../../lib/useInView.ts';

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

/** Легенда «Менше…Більше» (стиль GitHub contribution graph) — той самий
 *  cellBg, що клітинки сітки, тож рівень кольору тут ідентичний реальному.
 *  Замінює єдине пояснення, яке раніше було лише в hover-title (марно на
 *  тач-екрані Mini App — фідбек власника, п.10.1). */
function HeatmapLegend() {
  return (
    <div className="mt-1.5 flex items-center gap-1 text-[9px] text-tx3">
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
    </div>
  );
}

export function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  // Хвиля появи, коли карта доїхала до екрана (вона глибоко під згином).
  const [ref, inView] = useInView<HTMLDivElement>();
  const cols: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

  return (
    <div ref={ref}>
      {/* Колонки НЕ розтягуємо (без flex-1) — у макеті теплокарта компактна,
          клітинка 9px, ліворуч; решта ширини лишається повітрям. */}
      <div className="flex gap-[3px]">
        {cols.map((col, ci) => (
          <div key={ci} className="flex flex-col gap-[3px]">
            {col.map((c, ri) => (
              <div
                key={c.d}
                title={`${c.d}: ${c.v}`}
                className="w-[9px] rounded-[2.5px]"
                // Діагональна хвиля: тиждень (колонка) дає 35мс, день у колонці —
                // ще 10мс, тож фронт іде з лівого верху в правий низ ~600мс.
                // Одна клітинка 9px невидима (урок про розмір елемента), але
                // фронт біжить по ВСІЙ сітці ~141×75px — читається як «карта
                // проявилась», що і треба. fadeInSoft: from-only, колір у DOM.
                style={{
                  aspectRatio: '1',
                  background: cellBg(c.l),
                  animation: `fadeInSoft .45s ease-out ${ci * 35 + ri * 10}ms backwards`,
                  animationPlayState: inView ? 'running' : 'paused',
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <HeatmapLegend />
    </div>
  );
}
