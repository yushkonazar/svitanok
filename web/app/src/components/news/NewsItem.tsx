import type { NewsItem as NewsItemT } from '../../api/briefing-schema.ts';
import { useStats, useVote, useToggleSaveNews } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { postEvent } from '../../api/client.ts';
import { has } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';

// Айтем новини (дизайн v2, Svitanok.dc.html): заголовок + «чому» акцентом,
// праворуч три квадратні кнопки 👍/👎/🔖 (активна — кольорова рамка+тло).
// Голос — зі stats.votes (сервер не обрізає), збереження — session-sticky.

export function NewsItem({ item, topic }: { item: NewsItemT; topic: string }) {
  const { data } = useStats();
  const vote = data?.stats.votes?.[item.url] ?? null;
  const { isSaved, setSaved } = useSaved();
  const saved = isSaved('news', item.url);
  const voteMut = useVote();
  const saveMut = useToggleSaveNews();

  const openNews = () => {
    openLink(item.url);
    void postEvent('news_click', { category: topic, url: item.url }).catch(() => {});
  };

  const btn = (
    label: string,
    on: boolean,
    onClick: () => void,
    onBg: string,
    onBrd: string,
    aria: string,
  ) => (
    <button
      type="button"
      aria-label={aria}
      aria-pressed={on}
      onClick={onClick}
      className="grid h-8 w-8 flex-none place-items-center rounded-[10px] border text-sm transition-colors"
      style={{
        background: on ? onBg : 'var(--color-glass)',
        borderColor: on ? onBrd : 'var(--color-glassb)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-2.5">
      <button type="button" onClick={openNews} className="min-w-0 flex-1 text-left">
        <span className="block text-[13.5px] font-semibold leading-[1.35]">{item.title}</span>
        {has(item.why) && (
          <span className="mt-0.5 block font-mono text-[10.5px] font-medium text-a2">{item.why}</span>
        )}
      </button>
      <div className="flex flex-none gap-1.5">
        {btn(
          '👍',
          vote === 'up',
          () => {
            voteMut.mutate({ category: topic, dir: 'up', url: item.url });
            haptic('light');
          },
          'rgba(120,220,160,.16)',
          'var(--color-pos)',
          'Подобається',
        )}
        {btn(
          '👎',
          vote === 'down',
          () => {
            voteMut.mutate({ category: topic, dir: 'down', url: item.url });
            haptic('light');
          },
          'rgba(255,120,120,.14)',
          'var(--color-neg)',
          'Не подобається',
        )}
        {btn(
          '🔖',
          saved,
          () => {
            const next = !saved;
            setSaved('news', item.url, next);
            saveMut.mutate(
              { save: next, url: item.url, title: item.title, category: topic },
              { onError: () => setSaved('news', item.url, saved) },
            );
            haptic('success');
          },
          'rgba(255,164,92,.16)',
          'var(--color-a2)',
          saved ? 'Прибрати зі збереженого' : 'Зберегти',
        )}
      </div>
    </div>
  );
}
