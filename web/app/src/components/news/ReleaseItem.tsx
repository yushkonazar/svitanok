import type { NewsItem as NewsItemT } from '../../api/briefing-schema.ts';
import { releaseRepo } from '../../lib/newsSource.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { useTick } from '../../lib/useTick.ts';
import { openLink } from '../../telegram.ts';

// Рядок релізу (редизайн новин) — ІНША форма даних, ніж новина: версія/тег +
// час, БЕЗ "чому" (releases.atom не дає опису) і без ❤️/🔖 (реліз не
// "подобається" й не "зберігається" — це версія, не стаття). Формат картки
// свідомо відрізняється від NewsItem.

export function ReleaseItem({ item }: { item: NewsItemT }) {
  useTick(60_000); // «час тому» саме старіє на екрані, без рефетчу
  const repo = releaseRepo(item.url);
  const ago = timeAgo(item.publishedAt);

  return (
    <button
      type="button"
      onClick={() => openLink(item.url)}
      className="flex w-full items-center gap-2.5 text-left"
    >
      <div className="min-w-0 flex-1">
        <span className="block font-mono text-[9.5px] font-semibold text-tx3">{repo}</span>
        <span className="block text-[13.5px] font-semibold leading-[1.35]">{item.title}</span>
      </div>
      {ago && <span className="flex-none font-mono text-[10px] font-medium text-tx3">{ago}</span>}
    </button>
  );
}
