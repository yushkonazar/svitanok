// Стовпчикова діаграма (роадмеп v3, E1) — 1:1 з index.html barsChart (1639-1650).
// Спільний каркас для тижневої активності (weekbars) і гістограми fit% (hist).
// Порожні бари (value<=0) — 3% висоти кольором треку; інакше max(6, %).

const GRAD = 'linear-gradient(135deg, var(--grad-from), var(--grad-to))';

export interface BarItem {
  label: string;
  value: number;
}

export function BarsChart({
  items,
  showCount = false,
  variant = 'week',
}: {
  items: BarItem[];
  showCount?: boolean;
  variant?: 'week' | 'hist';
}) {
  const height = variant === 'hist' ? 88 : 74;
  const max = Math.max(1, ...items.map((x) => x.value || 0));

  return (
    <div>
      <div className="flex items-end" style={{ height }}>
        {items.map((it, i) => {
          const off = !(it.value > 0);
          const heightPct = Math.round(((it.value || 0) / max) * 100);
          const barPct = off ? 3 : Math.max(6, heightPct);
          return (
            <div key={i} className="relative flex-1" style={{ height }}>
              {showCount && it.value > 0 && (
                <div
                  className="absolute inset-x-0 text-center text-[10px] leading-none text-muted"
                  style={{ bottom: `calc(${barPct}% + 3px)` }}
                >
                  {it.value}
                </div>
              )}
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2"
                style={{
                  width: '68%',
                  height: `${barPct}%`,
                  borderRadius: '5px 5px 0 0',
                  background: off ? 'var(--color-track)' : GRAD,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex">
        {items.map((it, i) => (
          <div key={i} className="flex-1 text-center text-[10px] text-muted">
            {it.label}
          </div>
        ))}
      </div>
    </div>
  );
}
