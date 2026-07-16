import type { Stats, SavedItem } from '../../api/schema.ts';
import { has, truncate } from '../../lib/format.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { openLink } from '../../telegram.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';

// D · Інтереси (дизайн v2, Svitanok.dc.html): картка головної теми тижня
// (частка реакцій + напрямок vs минулий тиждень) + чипи решти тем.
// Список збереженого макет не показує, але це наявна функція (backend + D2) —
// лишаємо компактним блоком нижче.

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
    <div className="flex items-center gap-2 border-t border-hair py-1.5 text-[12px]">
      <span>{icon}</span>
      {item.kind === 'news' && item.url ? (
        <button
          type="button"
          onClick={() => openLink(item.url!)}
          className="flex-1 truncate text-left text-a2"
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
  const top = s.interests[0];
  const rest = s.interests.slice(1);
  const total = s.interests.reduce((a, x) => a + x.score, 0);
  const share = top && total > 0 ? Math.round((top.score / total) * 100) : 0;

  // Напрямок vs минулий тиждень — із тренду головної теми.
  let trend = '';
  const series = top ? s.interestsTrend.topics.find((t) => t.topic === top.topic)?.series : undefined;
  if (series && series.length >= 2) {
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    trend = last > prev ? ' · ↑ vs минулий' : last < prev ? ' · ↓ vs минулий' : ' · = vs минулий';
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Інтереси</SectionHead>

      {top ? (
        <>
          <div className="flex items-center gap-3.5 rounded-2xl border border-glassb bg-glass p-4">
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
                ГОЛОВНИЙ ЦЬОГО ТИЖНЯ
              </span>
              <div className="flex items-baseline gap-2">
                <span className="text-[17px]">{topicEmoji(top.topic)}</span>
                <span className="truncate text-[17px] font-bold">{top.topic}</span>
              </div>
              <span className="text-[10.5px] font-medium text-tx2">
                {share}% усіх реакцій{trend}
              </span>
            </div>
            <div
              className="ml-auto font-mono text-[40px] font-medium leading-none tracking-[-0.03em]"
              style={{
                background: 'var(--grad)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              {top.score}
            </div>
          </div>

          {rest.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {rest.map((it) => (
                <span
                  key={it.topic}
                  className="rounded-full border border-glassb bg-glass px-[11px] py-1.5 text-[11px] font-semibold text-tx2"
                >
                  {topicEmoji(it.topic)} {it.topic} {it.score}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <Ph>Лайкай новини — і тут з’являться твої теми</Ph>
      )}

      {has(s.readPerDay) && <StatRow label="Новин на день (середнє)" value={s.readPerDay} />}

      {s.savedCount > 0 && (
        <div className="flex flex-col">
          <StatRow label="🔖 Ти зберіг" value={s.savedCount} />
          {s.savedList.map((item, i) => (
            <SavedRow key={item.id ?? i} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
