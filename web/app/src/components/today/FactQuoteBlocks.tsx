import type { FactData, StoicData } from '../../api/briefing-schema.ts';
import { textHash } from '../../lib/format.ts';
import { SectionLabel } from '../ui/primitives.tsx';
import { SaveButton } from './SaveButton.tsx';

// 🧠 Факт дня + 🏛 Думка дня (дизайн v2, Svitanok.dc.html).
// Факт: моно-лейбл + текст із «маркерним» підсвічуванням хвоста речення.
// Цитата: велика градієнтна лапка, курсив, риска + автор капсом.

export function FactBlock({ d }: { d: FactData }) {
  const id = textHash(d.fact);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionLabel>ФАКТ ДНЯ</SectionLabel>
        <div className="ml-auto">
          <SaveButton kind="fact" id={id} title={d.fact} />
        </div>
      </div>
      <div className="text-[14.5px] font-medium leading-[1.55]">{d.fact}</div>
    </div>
  );
}

export function QuoteBlock({ d }: { d: StoicData }) {
  // id/title — за КОМБІНОВАНИМ рядком «текст» — автор (як vanilla qtId).
  // ⚠️ Формат рядка НЕ чіпати: з нього рахується textHash = id збереженого в KV.
  // Зміниш лапки — і всі раніше збережені цитати стануть «незбереженими».
  const title = `«${d.text}» — ${d.author}`;
  const id = textHash(title);
  return (
    <div className="flex flex-col gap-2">
      {/* Шапка як у «Факті дня» й «Питанні дня»: підпис секції + 🔖 праворуч.
          Доти цей блок був єдиним без підпису, а кнопка жила внизу в рядку
          автора — через це вона й здавалась зʼїхалою відносно сусідів. */}
      <div className="flex items-center gap-2">
        <SectionLabel>ДУМКА ДНЯ</SectionLabel>
        <div className="ml-auto">
          <SaveButton kind="quote" id={id} title={title} />
        </div>
      </div>

      <div className="relative pl-11 pt-1.5">
        <div
          className="absolute left-0 top-[-8px] text-[58px] font-extrabold leading-none"
          style={{
            background: 'var(--grad)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
          aria-hidden="true"
        >
          «
        </div>
        <div className="text-base font-medium italic leading-[1.5]">{d.text}</div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-[1.5px] w-[22px] bg-a2" />
          <span className="font-mono text-[10.5px] font-medium text-tx3">
            {d.author.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}
