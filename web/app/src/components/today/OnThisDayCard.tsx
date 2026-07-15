import { useState } from 'react';
import type { Brief } from '../../api/briefing-schema.ts';
import { readBlock, onThisDayDataSchema } from '../../api/briefing-schema.ts';
import { has } from '../../lib/format.ts';
import { openLink } from '../../telegram.ts';
import { Card } from '../ui/primitives.tsx';

// 📜 У цей день (роадмеп v3, E2) — 1:1 з index.html (1796-1814). Спершу 8, «Показати
// ще» додає по 2 з резерву (клієнтський стан, без fetch). D3: кнопка «Відкрити» на
// подіях зі статтею Вікіпедії.

const INITIAL = 8;
const STEP = 2;

export function OnThisDayCard({ brief }: { brief: Brief }) {
  const [shownCount, setShownCount] = useState(INITIAL);
  const d = readBlock(brief.blocks, 'onthisday', onThisDayDataSchema);
  if (!d || !d.events.length) return null;

  const shown = Math.min(shownCount, d.events.length);
  const remaining = d.events.length - shown;

  return (
    <Card title="📜 У цей день">
      <div className="flex flex-col gap-1.5 text-sm">
        {d.events.slice(0, shown).map((e, i) => (
          <div key={i}>
            <b>{e.year}</b> — {e.text}
            {has(e.url) && (
              <button
                type="button"
                onClick={() => openLink(e.url!)}
                className="ml-1 whitespace-nowrap text-accent"
              >
                Відкрити ↗
              </button>
            )}
          </div>
        ))}
      </div>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setShownCount((c) => c + STEP)}
          className="mt-3 rounded-full bg-surface-2 px-4 py-1.5 text-sm font-medium transition-colors hover:bg-border"
        >
          Показати ще ({Math.min(STEP, remaining)})
        </button>
      )}
    </Card>
  );
}
