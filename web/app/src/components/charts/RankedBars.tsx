import { cascade } from '../ui/Cascade.tsx';

// Горизонтальний рейтинг «підпис — смуга — число»: один компонент на ТРИ
// місця «Подробиць» (блокери, помічники, куди йде час). Доти кожен із них
// малювався власною розміткою, і три майже однакові списки розповзались у
// стилях; тут форма одна, різні лише дані й акцент.
//
// Смуга масштабується від МАКСИМУМУ ряду, не від суми: питання «що частіше
// за що», а не «яка частка цілого» — при мультивиборі частки все одно не
// складаються в 100%.

export interface RankedRow {
  key: string;
  label: string;
  n: number;
  /** Правий підпис (напр. «оцінка 3.4»); не показуємо, якщо null. */
  note?: string | null;
  noteColor?: string;
}

export function RankedBars({
  rows,
  color = 'var(--color-a2)',
  suffix = '×',
}: {
  rows: RankedRow[];
  color?: string;
  suffix?: string;
}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.n), 1);

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={r.key} style={cascade(i, 45)} className="flex flex-col gap-[3px]">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[12px] font-semibold text-tx">{r.label}</span>
            {r.note && (
              <span
                className="ml-auto flex-none font-mono text-[10.5px]"
                style={{ color: r.noteColor ?? 'var(--color-tx2)' }}
              >
                {r.note}
              </span>
            )}
            <span
              className={`${r.note ? '' : 'ml-auto'} flex-none font-mono text-[10.5px] text-tx3`}
            >
              {r.n}
              {suffix}
            </span>
          </div>
          <div className="h-[6px] overflow-hidden rounded-full bg-track">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.round((r.n / max) * 100)}%`, background: color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
