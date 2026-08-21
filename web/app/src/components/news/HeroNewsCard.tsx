import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { haptic } from '../../telegram.ts';
import { GlassCard } from '../ui/primitives.tsx';
import { NewsItem } from './NewsItem.tsx';
import { pluralizeNova } from './pluralize.ts';

// Топ-теми (ті самі, що потрапили в DigestCard) — ПОВНА картка, не голий
// прев'ю: заголовок теми з лічильником, сама новина через NewsItem (джерело+
// час+заголовок+чому+❤️🔖 — усе, що вже вміє NewsItem, тут не задубльовано),
// і другий айтем — компактний пік-рядок нижче, тап на який (чи на заголовок
// теми) відкриває повний Sheet. Це і є "не голі картки" з фідбеку власника —
// різниця з CompactNewsCard саме в обсязі видимого одразу, без тапу.

export function HeroNewsCard({ group, onOpenAll }: { group: NewsGroupT; onOpenAll: () => void }) {
  const lead = group.items[0];
  const peek = group.items[1] ?? group.more[0];
  const count = group.items.length + group.more.length;
  if (!lead) return null;

  return (
    <GlassCard className="p-3.5">
      <button
        type="button"
        onClick={() => {
          haptic('light');
          onOpenAll();
        }}
        className="mb-2 flex w-full items-center gap-2 text-left"
      >
        <span className="text-base">{topicEmoji(group.topic)}</span>
        <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-tx2">
          {group.topic.toUpperCase()}
        </span>
        {count > 0 && (
          <span
            className="ml-auto rounded-full px-2 py-0.5 font-mono text-[10px] font-bold"
            style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
          >
            +{count} {pluralizeNova(count)}
          </span>
        )}
      </button>

      <NewsItem item={lead} topic={group.topic} />

      {peek && (
        <button
          type="button"
          onClick={() => {
            haptic('light');
            onOpenAll();
          }}
          className="mt-2.5 flex w-full items-center gap-2 border-t border-glassb pt-2.5 text-left"
        >
          <span className="flex-none text-tx3">•</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-tx2">{peek.title}</span>
          {timeAgo(peek.publishedAt) && (
            <span className="flex-none font-mono text-[10px] text-tx3">
              {timeAgo(peek.publishedAt)}
            </span>
          )}
        </button>
      )}
    </GlassCard>
  );
}
