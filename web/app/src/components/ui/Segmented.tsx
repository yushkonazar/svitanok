// Сегмент-контрол (дизайн v2, Svitanok.dc.html): скляна доріжка, активний
// сегмент — градієнтна пігулка. Використовують Новини (Світ/Україна) і
// Вакансії (Список/Канбан).

export interface Segment<T extends string> {
  id: T;
  label: string;
}

export function Segmented<T extends string>({
  segments,
  value,
  onChange,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-2xl border border-glassb bg-glass p-1">
      {segments.map((s) => {
        const on = s.id === value;
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(s.id)}
            className={`flex-1 rounded-[11px] py-[9px] text-center text-[12.5px] transition-all duration-200 ${
              on ? 'sheen font-bold' : 'font-semibold text-tx2'
            }`}
            style={on ? { background: 'var(--grad)', color: 'var(--color-onacc)' } : undefined}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
