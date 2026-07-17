import { useNavigate } from 'react-router-dom';
import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { haptic } from '../../telegram.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';

// D · Інтереси (дизайн v2, Svitanok.dc.html): картка головної теми тижня
// (частка реакцій + напрямок vs минулий тиждень) + чипи решти тем.
//
// Архів збереженого ПІШОВ звідси на власний маршрут /saved (фідбек власника,
// п.6: «окреме місце з групуванням і видаленням»). Тут лишається лише вхід —
// рядок із лічильником. Заразом це зняло тихий баг: список гортався ростом
// limit (20→40→60…) при зашитому offset=0, а сервер клампить limit до 50 —
// тож після 50-го запису «Показати ще» рахувало залишок, але не додавало нічого.

/** Вхід в архів: лічильник + шеврон. Сам список живе на /saved. */
function SavedLink({ total }: { total: number }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        navigate('/saved');
        haptic('light');
      }}
      className="flex items-center gap-2 rounded-2xl border border-glassb bg-glass px-3.5 py-3 text-left"
    >
      <span className="text-[13px] font-semibold">🔖 Збережене</span>
      <span className="ml-auto font-mono text-[13px] font-semibold text-tx2">{total}</span>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-tx3)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 5l7 7-7 7" />
      </svg>
    </button>
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

      {s.savedCount > 0 && <SavedLink total={s.savedCount} />}
    </div>
  );
}
