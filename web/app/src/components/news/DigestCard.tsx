import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { openLink, haptic } from '../../telegram.ts';
import { postEvent } from '../../api/client.ts';
import { GlassCard } from '../ui/primitives.tsx';

// «Ранковий дайджест» (редизайн новин) — топ-3 з найвищим пріоритетом груп:
// `groups` уже відсортовані бекендом за вагою 👍/❤️ спадно (news.ts,
// createNewsModule), тож перші НЕ приглушені групи й Є «улюблене» — жодних
// нових бекенд-даних не треба, просто перший item кожної з перших трьох.

function pluralizePodiya(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'подія';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'події';
  return 'подій';
}

export function DigestCard({ groups }: { groups: NewsGroupT[] }) {
  const picks = groups.filter((g) => g.items.length > 0).slice(0, 3);
  if (picks.length === 0) return null;

  return (
    <GlassCard className="p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-sm">⚡</span>
        <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-tx2">
          РАНКОВИЙ ДАЙДЖЕСТ
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 font-mono text-[10px] font-bold"
          style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
        >
          {picks.length} {pluralizePodiya(picks.length)}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {picks.map((g, i) => {
          const item = g.items[0]!;
          const tag = [newsSource(item.url), g.topic].filter(Boolean).join(' ').toUpperCase();
          return (
            <button
              key={item.url}
              type="button"
              onClick={() => {
                haptic('light');
                openLink(item.url);
                void postEvent('news_click', { category: g.topic, url: item.url }).catch(() => {});
              }}
              className={`flex w-full items-start gap-2.5 text-left${i > 0 ? ' border-t border-glassb pt-2.5' : ''}`}
            >
              <span className="mt-0.5 text-base">{topicEmoji(g.topic)}</span>
              <div className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-[1.35]">{item.title}</span>
                <span className="mt-0.5 block font-mono text-[9.5px] font-semibold text-tx3">
                  {tag}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </GlassCard>
  );
}
