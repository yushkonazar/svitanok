import type { Brief } from '../../api/briefing-schema.ts';
import { readBlock, factDataSchema, stoicDataSchema } from '../../api/briefing-schema.ts';
import { textHash } from '../../lib/format.ts';
import { Card } from '../ui/primitives.tsx';
import { SaveButton } from './SaveButton.tsx';

// 🧠 Факт дня + 🏛 Думка дня (роадмеп v3, E2) — 1:1 з index.html (1770-1794).
// Прості картки з кнопкою 🔖 у хедері.

export function FactCard({ brief }: { brief: Brief }) {
  const d = readBlock(brief.blocks, 'fact', factDataSchema);
  if (!d) return null;
  const id = textHash(d.fact);
  return (
    <Card title="🧠 Факт дня" action={<SaveButton kind="fact" id={id} title={d.fact} />}>
      <p className="text-sm">{d.fact}</p>
    </Card>
  );
}

export function ThoughtCard({ brief }: { brief: Brief }) {
  const d = readBlock(brief.blocks, 'stoic', stoicDataSchema);
  if (!d) return null;
  // id/title — за КОМБІНОВАНИМ рядком «текст» — автор (як vanilla qtId).
  const title = `«${d.text}» — ${d.author}`;
  const id = textHash(title);
  return (
    <Card title="🏛 Думка дня" action={<SaveButton kind="quote" id={id} title={title} />}>
      <p className="text-base italic">«{d.text}»</p>
      <p className="mt-2 text-sm text-muted">— {d.author}</p>
    </Card>
  );
}
