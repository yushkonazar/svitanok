import type { Brief } from '../../api/briefing-schema.ts';
import { readBlock, mockDataSchema } from '../../api/briefing-schema.ts';
import { useStats, useMockAnswer } from '../../api/hooks.ts';
import { has, textHash } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';
import { Card } from '../ui/primitives.tsx';
import { Expandable } from '../ui/Expandable.tsx';
import { SaveButton } from './SaveButton.tsx';

// 🎤 Питання дня (роадмеп v3, E2) — 1:1 з index.html (1738-1767). Розкриття
// показує підказку+відповідь+оцінку(😌/😰)+«Вивчити». (v2-покращення — F4.)

function RateButtons({ topic }: { topic: string }) {
  const { data } = useStats();
  const rate = useMockAnswer();
  const rated = !!data?.stats.mockRatedToday;

  const btn = (rating: 'easy' | 'hard', label: string) => (
    <button
      type="button"
      disabled={rated}
      onClick={() => {
        rate.mutate({ topic, rating });
        haptic('success');
      }}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        rated ? 'bg-accent/20 text-accent' : 'bg-surface-2 hover:bg-border'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-2 flex gap-2">
      {btn('easy', '😌 Легко')}
      {btn('hard', '😰 Важко')}
    </div>
  );
}

export function QuestionCard({ brief }: { brief: Brief }) {
  const d = readBlock(brief.blocks, 'mock', mockDataSchema);
  if (!d) return null;

  const qId = textHash(d.question);
  const base = <div className="font-medium">{d.question}</div>;
  const more = (
    <div className="mt-2 flex flex-col gap-2 text-sm">
      {has(d.hint) && <div className="text-muted">💡 {d.hint}</div>}
      {has(d.answer) ? (
        <div>{d.answer}</div>
      ) : (
        <div className="text-muted">
          Відповідь з’явиться згодом. Спробуй відповісти вголос — тренування до співбесіди.
        </div>
      )}
      {has(d.answer) && <RateButtons topic={d.topic || ''} />}
      {has(d.resourceUrl) && (
        <button
          type="button"
          onClick={() => openLink(d.resourceUrl!)}
          className="mt-1 self-start text-accent"
        >
          📚 Вивчити
        </button>
      )}
    </div>
  );

  return (
    <Card title="🎤 Питання дня" action={<SaveButton kind="question" id={qId} title={d.question} />}>
      <Expandable base={base} more={more} />
    </Card>
  );
}
