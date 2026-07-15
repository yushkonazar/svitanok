import { clamp } from '../../lib/format.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';

// Горизонтальний список-бар (роадмеп v3, E1) — 1:1 з index.html barList
// (2663-2671). Використовується для слабких тем mock (%).

const GRAD = 'linear-gradient(135deg, var(--grad-from), var(--grad-to))';

export interface BarListItem {
  name: string;
  value: number;
}

export function BarList({
  items,
  unit = '',
  emptyText,
}: {
  items: BarListItem[];
  unit?: string;
  emptyText: string;
}) {
  if (!items.length) {
    return <div className="py-1 text-sm text-muted">{emptyText}</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="basis-[42%] truncate text-sm" title={it.name}>
            {topicEmoji(it.name)} {it.name}
          </div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-track">
            <div
              className="h-full rounded-full"
              style={{ width: `${clamp(it.value, 0, 100)}%`, background: GRAD }}
            />
          </div>
          <div className="min-w-[34px] text-right text-sm text-muted">
            {it.value}
            {unit}
          </div>
        </div>
      ))}
    </div>
  );
}
