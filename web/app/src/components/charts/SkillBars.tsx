import { clamp } from '../../lib/format.ts';
import { useInView } from '../../lib/useInView.ts';

// Смуги навичок / слабких тем (дизайн v2, Svitanok.dc.html): назва (74px) —
// доріжка 8px із градієнтною заливкою — відсоток (34px, праворуч).

export interface SkillBar {
  name: string;
  pct: number;
}

export function SkillBars({ items, emptyText }: { items: SkillBar[]; emptyText: string }) {
  // Хук ДО раннього return — порядок хуків мусить бути сталим між рендерами.
  const [ref, inView] = useInView<HTMLDivElement>();
  if (!items.length) return <div className="py-1 text-[11.5px] text-tx3">{emptyText}</div>;
  return (
    <div ref={ref} className="flex flex-col gap-2.5">
      {items.map((s, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <span className="w-[74px] shrink-0 truncate text-[11.5px] font-medium" title={s.name}>
            {s.name}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-track">
            <div
              className="h-full rounded-full"
              style={{
                width: `${clamp(s.pct, 0, 100)}%`,
                background: 'linear-gradient(90deg,var(--color-a1),var(--color-a2))',
                animation: inView
                  ? `barFill .6s cubic-bezier(.22,1,.36,1) ${i * 60}ms backwards`
                  : undefined,
              }}
            />
          </div>
          <span className="w-[34px] text-right font-mono text-[11px] font-semibold text-tx2">
            {s.pct}%
          </span>
        </div>
      ))}
    </div>
  );
}
