import { useState } from 'react';
import type { OnThisDayData } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { openLink } from '../../telegram.ts';
import { SectionLabel } from '../ui/primitives.tsx';
import { cascade } from '../ui/Cascade.tsx';

// 📜 У цей день (дизайн v2, Svitanok.dc.html): рік великим моно праворуч-
// вирівняно + текст; перший рік акцентований. Спершу 3, «Показати ще» розкриває
// решту (клієнтський стан). D3: подія зі статтею Вікіпедії має «Відкрити ↗».

const INITIAL = 3;

export function ThisDayBlock({ d }: { d: OnThisDayData }) {
  const [open, setOpen] = useState(false);
  if (!d.events.length) return null;

  const shown = open ? d.events : d.events.slice(0, INITIAL);
  const rest = d.events.length - INITIAL;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SectionLabel>У ЦЕЙ ДЕНЬ</SectionLabel>
        <span className="ml-auto font-mono text-[10px] font-medium text-tx3">
          {d.events.length} ПОДІЙ
        </span>
      </div>

      {/* Розкриті рядки (i >= INITIAL) рахують затримку від нуля — «Показати ще»
          грає власний каскад одразу, а не досиджує хвіст за першими трьома.
          Стилі перших трьох при цьому НЕ міняються (рядок той самий) — рестарту
          їхньої анімації немає. */}
      {shown.map((e, i) => (
        <div
          key={`${e.year}-${i}`}
          className="flex items-baseline gap-3"
          style={cascade(i >= INITIAL ? i - INITIAL : i, 45, 6)}
        >
          <span
            className="w-16 flex-none text-right font-mono text-[22px] font-bold tracking-[-0.03em]"
            style={{ color: i === 0 ? 'var(--color-a2)' : 'var(--color-tx3)' }}
          >
            {e.year}
          </span>
          <span className="text-[12.5px] leading-[1.45]">
            {e.text}
            {has(e.url) && (
              <button
                type="button"
                onClick={() => openLink(e.url!)}
                className="ml-1.5 whitespace-nowrap font-semibold text-a1"
              >
                Відкрити ↗
              </button>
            )}
          </span>
        </div>
      ))}

      {rest > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start text-[11.5px] font-semibold text-tx2"
        >
          {open ? 'Згорнути ↑' : `Показати ще (${rest}) ↓`}
        </button>
      )}
    </div>
  );
}
