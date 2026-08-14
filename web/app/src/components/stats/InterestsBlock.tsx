import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { haptic } from '../../telegram.ts';
import { MiniTrend } from '../charts/MiniTrend.tsx';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionHead, StatRow, Ph, Hint } from '../ui/primitives.tsx';
import { useCountUp } from '../ui/CountUp.tsx';
import { InterestTrend } from '../charts/InterestTrend.tsx';
import { interestShifts, focusPct } from '../../lib/interestShift.ts';

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
  // Рух, а не знімок: теми, що помітно зросли або згасли за останній місяць
  // проти попереднього. Доти напрямок був видний ЛИШЕ в головної теми — тобто
  // саме тієї, про яку й так усе зрозуміло.
  const shifts = interestShifts(s.interestsTrend);
  const focus = focusPct(s.interests);
  const heroScore = useCountUp(top?.score ?? 0, heroInView);
  const rest = s.interests.slice(1);
  const [tapped, setTapped] = useState<string | null>(null);
  const tappedSeries = tapped
    ? (s.interestsTrend.topics.find((t) => t.topic === tapped)?.series ?? null)
    : null;
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
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-2">
                {rest.map((it) => {
                  // ⚠️ Чип показував БАЛ ЗА ВЕСЬ ЧАС — число, яке не рухається
                  // й нічого не пропонує зробити. Тап дістає з interestsTrend
                  // (він і так у payload) тижневий ряд теми: видно, чи вона
                  // жива зараз, чи стоїть у топі за старими заслугами.
                  const hasSeries = s.interestsTrend.topics.some((t) => t.topic === it.topic);
                  return (
                    <button
                      key={it.topic}
                      type="button"
                      disabled={!hasSeries}
                      aria-pressed={tapped === it.topic}
                      onClick={() => {
                        haptic('light');
                        setTapped(tapped === it.topic ? null : it.topic);
                      }}
                      className={`rounded-full border px-[11px] py-1.5 text-[11px] font-semibold ${
                        tapped === it.topic
                          ? 'border-tx3 bg-glass text-tx'
                          : 'border-glassb bg-glass text-tx2'
                      }`}
                    >
                      {topicEmoji(it.topic)} {it.topic} {it.score}
                    </button>
                  );
                })}
              </div>
              {tappedSeries && (
                <div className="rounded-xl border border-glassb bg-glass px-2.5 py-2">
                  <div className="font-mono text-[9.5px] text-tx3">
                    {tapped} · по тижнях за {s.interestsTrend.weeks.length} тиж.
                  </div>
                  <div className="mt-1">
                    <MiniTrend weeks={s.interestsTrend.weeks} series={tappedSeries} />
                  </div>
                </div>
              )}
            </div>
          )}

          {shifts.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-2xl border border-glassb bg-glass p-3.5">
              <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
                ЩО ЗМІНИЛОСЬ ЗА МІСЯЦЬ
              </span>
              {shifts.slice(0, 4).map((sh) => (
                <div key={sh.topic} className="flex items-baseline gap-2 text-[11.5px]">
                  <span className="min-w-0 flex-1 truncate text-tx2">
                    {topicEmoji(sh.topic)} {sh.topic}
                  </span>
                  <span className="flex-none font-mono text-[10px] text-tx3">
                    {sh.prior} → {sh.recent}
                  </span>
                  <span
                    className="w-[54px] flex-none text-right font-mono text-[10.5px] font-semibold"
                    style={{
                      color: sh.direction === 'up' ? 'var(--color-pos)' : 'var(--color-tx3)',
                    }}
                  >
                    {sh.direction === 'up' ? '↑' : '↓'} ×
                    {(sh.direction === 'up' ? sh.ratio : 1 / sh.ratio).toFixed(1)}
                  </span>
                </div>
              ))}
              <Hint>
                Реакції за останні 4 тижні проти попередніх 4. Показані лише помітні зміни —
                рівні теми й дрібні коливання сюди не потрапляють, інакше список щотижня був би
                повний і нічого не означав. «Згасла» тема не гірша за іншу: це просто те, що
                тебе зараз цікавить менше.
              </Hint>
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

      {focus !== null && (
        <StatRow
          label="Зосередженість"
          value={`${focus}% реакцій — на головній темі`}
        />
      )}
      {/* ⚠️ НЕ «новин на день» — так це називалось доти, і назва була
          неправдою. Лічильник s.days[].news інкрементує ВИКЛЮЧНО подія
          news_click, тобто тап по заголовку в Mini App із переходом на
          зовнішнє джерело (NewsItem.tsx, DigestCard.tsx).

          Читання дайджесту в самому ранковому повідомленні Telegram не
          породжує НІЧОГО: месенджер не дає боту сигналу прочитання. А це
          основний спосіб споживання новин — заради нього бот і існує. Тобто
          показник, названий «новин на день», при щоденному читанні в чаті
          стабільно показував 0–1, і саме тому виглядав зламаним.

          Тепер назва описує рівно те, що вимірює подія. Знаменник — доби з
          активністю за всю історію (кап 365), тож вікно теж підписане: доти
          це був єдиний показник блоку без нього. */}
      {has(s.readPerDay) && (
        <StatRow
          label="Переходів на джерела · на активну добу"
          value={s.readPerDay}
        />
      )}
      {s.savedCount > 0 && <StatRow label="🔖 Збережено" value={s.savedCount} />}
    </div>
  );
}
