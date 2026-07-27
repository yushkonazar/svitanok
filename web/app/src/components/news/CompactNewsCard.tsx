import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { haptic } from '../../telegram.ts';

// Компактна 2-колонкова картка (теми поза топ-3, окрім релізів) — заголовок
// і джерело(а) видно ОДРАЗУ, без тапу (той самий принцип "не голі картки",
// що в HeroNewsCard, лише менше місця на екрані). Тап відкриває Sheet із
// повним списком і ❤️/🔖 на кожному айтемі.
//
// Мердж-теми (напр. «Наука» = NewsData + BBC + Guardian) показують ВСІ
// унікальні джерела серед перших кількох айтемів одним рядком через «·» —
// так само, як затверджений макет (BBC UKRAINE · TCH ЕКОНОМІКА).

export function CompactNewsCard({ group, onOpen }: { group: NewsGroupT; onOpen: () => void }) {
  const lead = group.items[0];
  if (!lead) return null;
  const sources = [
    ...new Set(
      group.items
        .slice(0, 3)
        .map((it) => newsSource(it.url))
        .filter(Boolean),
    ),
  ];

  return (
    <button
      type="button"
      onClick={() => {
        haptic('light');
        onOpen();
      }}
      className="rounded-2xl border border-glassb bg-glass p-3 text-left"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-sm">{topicEmoji(group.topic)}</span>
        <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-tx3">
          {group.topic.toUpperCase()}
        </span>
      </div>
      <div className="line-clamp-2 text-[12.5px] font-semibold leading-[1.35]">{lead.title}</div>
      {sources.length > 0 && (
        <div className="mt-1 truncate font-mono text-[9px] font-semibold text-a2">
          {sources.join(' · ')}
        </div>
      )}
    </button>
  );
}
