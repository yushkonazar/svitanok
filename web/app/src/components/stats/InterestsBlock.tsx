import type { Stats, SavedItem } from '../../api/schema.ts';
import { has, truncate } from '../../lib/format.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { openLink } from '../../telegram.ts';
import { Card, StatLine, SubHead, Ph } from '../ui/primitives.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';

// D · Інтереси (роадмеп v3, E1) — index.html:2537-2584. Видалення збереженого
// (кнопка ✕) — разом з рештою мутацій (save/vote) у E3; тут лише показ.

const KIND_ICON: Record<string, string> = {
  news: '📰',
  fact: '🧠',
  quote: '🏛',
  question: '🎤',
};

function SavedRow({ item }: { item: SavedItem }) {
  const icon = KIND_ICON[item.kind] ?? '🔖';
  const title = truncate(item.title, 80);
  return (
    <div className="flex items-center gap-2 border-t border-border/50 py-1.5 text-sm">
      <span>{icon}</span>
      {item.kind === 'news' && item.url ? (
        <button
          type="button"
          onClick={() => openLink(item.url!)}
          className="flex-1 truncate text-left text-accent"
          title={item.title}
        >
          {title}
        </button>
      ) : (
        <span className="flex-1 truncate" title={item.title}>
          {title}
        </span>
      )}
    </div>
  );
}

export function InterestsBlock({ s }: { s: Stats }) {
  const trendTopics = s.interestsTrend.topics.filter((t) => t.series.some((v) => v > 0)).slice(0, 5);
  const scoreOf = (topic: string) => s.interests.find((i) => i.topic === topic)?.score;

  return (
    <Card title="❤️ D · Інтереси">
      <div className="flex flex-wrap gap-2">
        {s.interests.length ? (
          s.interests.map((it) => (
            <span
              key={it.topic}
              className="flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-sm"
            >
              {topicEmoji(it.topic)} {it.topic}
              <span className="text-xs text-muted">{it.score}</span>
            </span>
          ))
        ) : (
          <Ph>Лайкай новини — і тут з’являться твої теми</Ph>
        )}
      </div>

      {trendTopics.length > 0 && (
        <>
          <SubHead>Тренд · 6 тижнів</SubHead>
          <div className="flex flex-col gap-1.5">
            {trendTopics.map((t) => {
              const score = scoreOf(t.topic);
              return (
                <div key={t.topic} className="flex items-center gap-2">
                  <div className="basis-[38%] truncate text-sm" title={t.topic}>
                    {topicEmoji(t.topic)} {t.topic}
                  </div>
                  <div className="flex-1">
                    <Sparkline values={t.series} w={200} h={22} />
                  </div>
                  <div className="min-w-[24px] text-right text-sm text-muted">
                    {has(score) ? score : ''}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {has(s.readPerDay) && <StatLine label="Новин на день (середнє)" value={s.readPerDay} />}

      {s.savedCount > 0 && (
        <>
          <StatLine label="🔖 Ти зберіг" value={s.savedCount} />
          <div>
            {s.savedList.map((item, i) => (
              <SavedRow key={item.id ?? i} item={item} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
