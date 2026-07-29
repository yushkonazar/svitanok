import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';
import { useCountUp } from '../ui/CountUp.tsx';
import { InterestTrend } from '../charts/InterestTrend.tsx';

// D · Інтереси (дизайн v2, Svitanok.dc.html): картка головної теми тижня
// (частка реакцій + напрямок vs минулий тиждень) + чипи решти тем.
//
// Архів збереженого ПІШОВ звідси на власний маршрут /saved (фідбек власника,
// п.6: «окреме місце з групуванням і видаленням»). Тут лишається лише вхід —
// рядок із лічильником. Заразом це зняло тихий баг: список гортався ростом
// limit (20→40→60…) при зашитому offset=0, а сервер клампить limit до 50 —
// тож після 50-го запису «Показати ще» рахувало залишок, але не додавало нічого.

export function InterestsBlock({ s }: { s: Stats }) {
  const top = s.interests[0];
  // Хуки — ДО умовного рендера (top може не бути), порядок сталий.
  // Герой-бал набігає, коли картка доїхала до екрана (блок глибоко внизу).
  const [heroRef, heroInView] = useInView<HTMLDivElement>();
  const heroScore = useCountUp(top?.score ?? 0, heroInView);
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
          <div ref={heroRef} className="flex items-center gap-3.5 rounded-2xl border border-glassb bg-glass p-4">
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
              {heroScore}
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

          {/* Пів року реальної тижневої історії (interestsTrend) уже лежали в
              API — раніше споживались лише як стрілочка "↑ vs минулий" вище.
              Тут той самий масив рендериться повним графіком (п.1 ідей). */}
          {s.interestsTrend.topics.length > 0 && s.interestsTrend.weeks.length >= 2 && (
            <div className="rounded-2xl border border-glassb bg-glass p-3.5">
              <span className="mb-2 block font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
                ТРЕНД ІНТЕРЕСУ
              </span>
              <InterestTrend trend={s.interestsTrend} />
            </div>
          )}
        </>
      ) : (
        <Ph>Лайкай новини — і тут з’являться твої теми</Ph>
      )}

      {has(s.readPerDay) && <StatRow label="Новин на день (середнє)" value={s.readPerDay} />}
      {s.savedCount > 0 && <StatRow label="🔖 Збережено" value={s.savedCount} />}
    </div>
  );
}
