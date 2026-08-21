import type { NewsItem as NewsItemT } from '../../api/briefing-schema.ts';
import { useStats, useVote, useToggleSaveNews } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { postEvent } from '../../api/client.ts';
import { has } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { useTick } from '../../lib/useTick.ts';

// Айтем новини (дизайн v2, Svitanok.dc.html): заголовок + «чому» акцентом,
// праворуч дві квадратні кнопки ❤️/🔖 (активна — кольорова рамка+тло).
// Голос — зі stats.votes (сервер не обрізає), збереження — session-sticky.
//
// ❤️ замість 👍/👎 (фідбек власника, п.5): лишився ЛИШЕ позитивний сигнал.
// Механіку тоглу не чіпали — applyUrlVote і так знімає голос на повторний клік
// того ж напрямку; тепер напрямок завжди один. Старі 👎 з KV нікуди не діли:
// сервер більше не дає їх СТВОРИТИ, але вміє прочитати й відкотити, якщо
// лайкнути раніше дизлайкнуту новину (див. коментар у web/worker.js).

export function NewsItem({ item, topic }: { item: NewsItemT; topic: string }) {
  // Живий тик (раз/хв) — «5 хв» саме старіє на екрані, без рефетчу даних.
  useTick(60_000);
  const { data } = useStats();
  // Лише 'up' підсвічує серце. Легасі-'down' у KV читається як «не лайкнуто»,
  // а не як активна кнопка: дизлайків більше немає, і малювати їх нічим.
  const liked = data?.stats.votes?.[item.url] === 'up';
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
      {/* key={String(on)} — ремоунт емодзі перезапускає pop на КОЖЕН тап. Без
          нього анімація програлась би раз при монтуванні й більше ніколи: CSS
          не рестартує кадри на зміну класу, лише на появу елемента.
          Сам pop лежав у index.css написаний і НЕ ВИКОРИСТАНИЙ ніде — тап у
          серце (головний жест вкладки) досі просто міняв колір. */}
      <span
        key={String(on)}
        className="block"
        style={{ animation: 'pop .28s cubic-bezier(.22,1,.36,1)' }}
      >
        {label}
      </span>
    </button>
  );

  const source = newsSource(item.url);
  const ago = timeAgo(item.publishedAt);

  return (
    <div className="flex items-center gap-2.5">
      <button type="button" onClick={openNews} className="min-w-0 flex-1 text-left">
        {(source || ago) && (
          <span className="mb-0.5 flex items-center gap-1.5 font-mono text-[9.5px] font-semibold text-tx3">
            {source && (
              <span className="rounded-[5px] border border-glassb px-1 py-[1px]">{source}</span>
            )}
            {ago && <span>{ago}</span>}
          </span>
        )}
        <span className="block text-[13.5px] font-semibold leading-[1.35]">{item.title}</span>
        {has(item.why) && (
          <span className="mt-0.5 block font-mono text-[10.5px] font-medium text-a2">
            {item.why}
          </span>
        )}
      </button>
      <div className="flex flex-none gap-1.5">
        {btn(
          '❤️',
          liked,
          () => {
            voteMut.mutate({ category: topic, url: item.url });
            haptic('light');
          },
          'rgba(255,110,122,.16)',
          'var(--color-a1)',
          liked ? 'Прибрати вподобання' : 'Подобається',
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
