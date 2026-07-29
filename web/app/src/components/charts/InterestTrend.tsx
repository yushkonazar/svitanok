import { useId, useMemo, useState } from 'react';
import type { InterestsTrend } from '../../api/schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { shortDateFromIso } from '../../lib/dateLabel.ts';
import { buildTrendPaths } from '../../lib/trendPath.ts';
import { haptic } from '../../telegram.ts';

// Тренд інтересу до тем новин за всю глибину ретенції (26 тижнів — WEEKLY_CAP,
// stats-core.mjs) — цей ряд даних уже лежав у /api/stats (interestsTrend), але
// споживався лише як 2-точкова стрілочка "↑/↓ vs минулий" в InterestsBlock.
// Тут та сама структура рендериться повним графіком.
//
// D3 тут — ЛИШЕ математика (scaleLinear для координат + d3-shape для path-
// рядків лінії/заливки), DOM малює React (той самий принцип, що вже
// задокументовано для проєкту — жодного d3.select/enter/exit).
//
// Палітра: не намагаємось дати кожній із 5 тем окремий насичений колір (у
// темі проєкту їх реально лише 2-3 несемантичних — a1/a2/info, решта
// зарезервовані під pos/neg). Натомість ОДНА тема в фокусі — акцентний
// градієнт+заливка, решта — тьмяні фонові лінії для контексту форми. Тап на
// чіп легенди перемикає фокус (диференціація через взаємодію, не веселку
// кольорів — той самий підхід, що й "не голі картки" в новинах).

const W = 300;
const H = 88;
const PAD_X = 3;
const PAD_Y = 6;
const TICK_EVERY = 6; // підпис дати що ~6 тижнів — інакше 26 підписів злипаються

export function InterestTrend({ trend }: { trend: InterestsTrend }) {
  const gradId = useId();
  const [focus, setFocus] = useState(0);
  const topics = trend.topics;
  const active = topics[focus] ?? topics[0];

  const { lineOf, areaOf } = useMemo(
    () =>
      buildTrendPaths(
        topics.map((t) => t.series),
        { width: W, height: H, padX: PAD_X, padY: PAD_Y },
      ),
    [topics],
  );

  if (!active || trend.weeks.length < 2) return null;

  const first = active.series[0] ?? 0;
  const last = active.series[active.series.length - 1] ?? 0;
  const delta = last - first;

  return (
    <div className="flex flex-col gap-2">
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--color-a1)" />
            <stop offset="1" stopColor="var(--color-a2)" />
          </linearGradient>
        </defs>
      </svg>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {topics.map((t, i) =>
          i === focus ? null : (
            <path
              key={t.topic}
              d={lineOf(t.series) ?? undefined}
              fill="none"
              stroke="var(--color-tx3)"
              strokeWidth="1"
              opacity="0.5"
            />
          ),
        )}
        <path d={areaOf(active.series) ?? undefined} fill={`url(#${gradId})`} opacity="0.14" stroke="none" />
        <path
          d={lineOf(active.series) ?? undefined}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>

      <div className="flex items-center justify-between font-mono text-[9px] text-tx3">
        <span>{shortDateFromIso(trend.weeks[0])}</span>
        {trend.weeks.length > TICK_EVERY && (
          <span>{shortDateFromIso(trend.weeks[Math.floor(trend.weeks.length / 2)])}</span>
        )}
        <span>{shortDateFromIso(trend.weeks[trend.weeks.length - 1])}</span>
      </div>

      <div className="flex items-center gap-1.5 text-[10.5px]">
        <span className="font-semibold">
          {topicEmoji(active.topic)} {active.topic}
        </span>
        <span
          className="font-mono"
          style={{ color: delta > 0 ? 'var(--color-pos)' : delta < 0 ? 'var(--color-neg)' : 'var(--color-tx3)' }}
        >
          {delta > 0 ? '↑' : delta < 0 ? '↓' : '→'} {Math.abs(delta)} за {trend.weeks.length} тиж.
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {topics.map((t, i) => (
          <button
            key={t.topic}
            type="button"
            onClick={() => {
              haptic('light');
              setFocus(i);
            }}
            className="rounded-full border px-2.5 py-1 text-[10px] font-semibold"
            style={
              i === focus
                ? { borderColor: 'rgba(255,164,92,.28)', background: 'rgba(255,164,92,.12)', color: 'var(--color-a2)' }
                : { borderColor: 'var(--color-glassb)', background: 'var(--color-glass)', color: 'var(--color-tx2)' }
            }
          >
            {topicEmoji(t.topic)} {t.topic}
          </button>
        ))}
      </div>
    </div>
  );
}
