import type { NewsItem as NewsItemT } from '../../api/briefing-schema.ts';
import { useStats, useVote, useToggleSaveNews } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { postEvent } from '../../api/client.ts';
import { has } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';

// Айтем новини (роадмеп v3, E3) — 1:1 з index.html newsItem (2282-2296): заголовок-
// посилання, «чому», кнопки 👍/👎/🔖. Голос — зі stats.votes (не обрізається),
// збереження — session-sticky (kind='news', id=url).

export function NewsItem({ item, topic }: { item: NewsItemT; topic: string }) {
  const { data } = useStats();
  const vote = data?.stats.votes?.[item.url] ?? null;
  const { isSaved, setSaved } = useSaved();
  const saved = isSaved('news', item.url);
  const voteMut = useVote();
  const saveMut = useToggleSaveNews();

  const openNews = () => {
    openLink(item.url);
    // Пасивний трек кліку (fire-and-forget; no-op поза Telegram).
    void postEvent('news_click', { category: topic, url: item.url }).catch(() => {});
  };

  const voteBtn = (dir: 'up' | 'down', icon: string, onCls: string) => (
    <button
      type="button"
      aria-label={dir === 'up' ? 'Подобається' : 'Не подобається'}
      onClick={() => {
        voteMut.mutate({ category: topic, dir, url: item.url });
        haptic('light');
      }}
      className={`flex h-8 w-8 items-center justify-center rounded-full text-base transition-colors ${
        vote === dir ? onCls : 'bg-surface-2 hover:bg-border'
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex items-start justify-between gap-2 border-t border-border/50 py-2 first:border-t-0">
      <button type="button" onClick={openNews} className="min-w-0 flex-1 text-left">
        <span className="text-sm font-medium">{item.title}</span>
        {has(item.why) && <div className="mt-0.5 text-xs text-muted">{item.why}</div>}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {voteBtn('up', '👍', 'bg-up/20 text-up')}
        {voteBtn('down', '👎', 'bg-down/20 text-down')}
        <button
          type="button"
          aria-label={saved ? 'Прибрати зі збереженого' : 'Зберегти'}
          onClick={() => {
            const next = !saved;
            setSaved('news', item.url, next);
            saveMut.mutate(
              { save: next, url: item.url, title: item.title, category: topic },
              // Відкат sticky-набору при збої (хук відкочує лише кеш ['stats']).
              { onError: () => setSaved('news', item.url, saved) },
            );
            haptic('success');
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-base transition-colors hover:bg-border"
        >
          {saved ? '✅' : '🔖'}
        </button>
      </div>
    </div>
  );
}
