import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionHead, Hint } from '../ui/primitives.tsx';
import { useCountUp } from '../ui/CountUp.tsx';
import { WeekBars } from '../charts/WeekBars.tsx';
import { Heatmap } from '../charts/Heatmap.tsx';
import { WeekdayBars } from '../charts/WeekdayBars.tsx';
import { OpenRhythm } from '../charts/OpenRhythm.tsx';
import { HabitTrend } from '../charts/HabitTrend.tsx';

// A · Звички — повний редизайн навколо питання «чи це вже РИТУАЛ».
//
// Стара версія показувала лише обсяг: два стріки, тижневі стовпчики, теплокарта
// й одна медіана часу. Дві речі при цьому мовчки губились:
//   1. days[] тримає ТРИ окремі лічильники (opens/mock/news), а теплокарта
//      сумувала їх в одне число — три різні за характером дні виглядали
//      однаково;
//   2. opensMin — цілий масив хвилин, з якого назовні йшла сама медіана.
//      А «о 8:20 ± 15 хв» і «о 8:20 ± 3 год» — протилежні історії з однаковою
//      медіаною: розкид і є різниця між звичкою та випадковістю.
//
// Нова структура — від сталості до обсягу:
//   Ритуал (коли й наскільки стабільно) -> Утримання (чи тримаюсь краще, ніж
//   місяць тому) -> Стріки -> Щоденна сітка -> День тижня.
//
// Порядок навмисний: стрік — наслідок ритуалу, а не його причина, тож великі
// числа стріку більше не відкривають блок.

function Tile({
  n,
  emoji,
  label,
  note,
  gradient = false,
}: {
  n: number;
  emoji?: string;
  label: string;
  note?: string;
  gradient?: boolean;
}) {
  // Стрік набігає від нуля (36px — рух видно здалеку). useInView — про запас.
  const [ref, inView] = useInView<HTMLDivElement>();
  const shown = useCountUp(n, inView);
  return (
    <div
      ref={ref}
      className="flex flex-1 flex-col gap-0.5 rounded-2xl border border-glassb bg-glass p-3.5"
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className="font-mono text-[36px] font-medium leading-none tracking-[-0.03em]"
          style={
            gradient
              ? {
                  background: 'var(--grad)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }
              : undefined
          }
        >
          {shown}
        </span>
        {emoji && <span className="text-[15px]">{emoji}</span>}
      </div>
      <span className="text-[10.5px] font-medium leading-[1.3] text-tx2">{label}</span>
      {note && <span className="font-mono text-[10px] font-semibold text-tx3">{note}</span>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-glassb bg-glass p-4">{children}</div>;
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">{children}</div>
  );
}

export function HabitsBlock({ s }: { s: Stats }) {
  const showHeatmap = s.heatmap.some((c) => c.v > 0);
  const best = s.streaks.bestOpenDays ?? 0;
  const cur = s.streaks.openDays || 0;

  // Утримання за останні 4 тижні проти попередніх 4 — одне число, що
  // відповідає на «краще чи гірше», не змушуючи читати весь графік.
  const hw = s.habitWeekly;
  const rate = (rows: typeof hw) => {
    const d = rows.reduce((a, w) => a + w.days, 0);
    return d > 0 ? rows.reduce((a, w) => a + w.active, 0) / d : null;
  };
  const recent = hw.length >= 8 ? rate(hw.slice(-4)) : null;
  const prior = hw.length >= 8 ? rate(hw.slice(-8, -4)) : null;
  const delta = recent !== null && prior !== null ? Math.round((recent - prior) * 100) : null;

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHead>Звички</SectionHead>

      {/* 1. РИТУАЛ — головне питання блоку. Не «скільки», а «наскільки сталo». */}
      {s.openRhythm.ready && (
        <Card>
          <SubLabel>РИТУАЛ ВІДКРИТТЯ</SubLabel>
          <div className="mt-2">
            <OpenRhythm rhythm={s.openRhythm} />
          </div>
          <Hint>
            Коли ти зазвичай уперше заходиш у застосунок. Смуга — не помилка, а РОЗКИД: жирна
            риска це типовий час, кольорова коробка — середня половина діб, вуса — майже всі
            інші. Вузька коробка означає ритуал, широка — що заходиш коли доведеться.
          </Hint>
        </Card>
      )}

      {/* 2. УТРИМАННЯ — тренд, якого не було взагалі: теплокарта показує
          щільність, але не відповідає «чи я тримаюсь краще, ніж місяць тому». */}
      {hw.length >= 2 && (
        <Card>
          <div className="flex items-baseline gap-2">
            <SubLabel>УТРИМАННЯ · 12 ТИЖНІВ</SubLabel>
            {delta !== null && (
              <span
                className="ml-auto font-mono text-[10.5px] font-semibold"
                style={{
                  color:
                    delta > 0
                      ? 'var(--color-pos)'
                      : delta < 0
                        ? 'var(--color-neg)'
                        : 'var(--color-tx3)',
                }}
              >
                {delta > 0 ? '↑' : delta < 0 ? '↓' : '→'} {Math.abs(delta)}% за міс.
              </span>
            )}
          </div>
          <div className="mt-2">
            <HabitTrend weeks={hw} />
          </div>
          <Hint>
            Висота стовпця — скільки діб тижня ти був активним (поточний тиждень рахується лише
            за дні, що вже минули). Кольори всередині — з чого та активність складалась. Тапни
            на тиждень, щоб побачити числа.
          </Hint>
        </Card>
      )}

      {/* 3. СТРІКИ — наслідок ритуалу, тому нижче, а не зверху. */}
      <div className="flex gap-2.5">
        <Tile
          gradient
          n={cur}
          emoji="🔥"
          label="днів поспіль відкрито"
          note={has(s.streaks.bestOpenDays) ? `РЕКОРД ${best}` : undefined}
        />
        <Tile n={s.streaks.mockDays || 0} label="днів поспіль питання" />
      </div>

      {has(s.streaks.bestOpenDays) && (
        <span className="-mt-1 font-mono text-[10px] font-semibold text-tx3">
          {cur >= best ? '🏆 Це вже рекорд!' : `До рекорду: ${best - cur} дн.`}
        </span>
      )}

      <WeekBars days={s.weekly} />

      {/* 4. ЩОДЕННА СІТКА — heatmap лишається (ui-ux-pro-max підтверджує його
          для time-based intensity), але клітинка тепер знає СКЛАД дня. */}
      {showHeatmap && (
        <Card>
          <SubLabel>ЩОДЕННА АКТИВНІСТЬ · 12 ТИЖНІВ</SubLabel>
          <div className="mt-2">
            <Heatmap cells={s.heatmap} />
          </div>
          <Hint>
            Кожен квадратик — доба, темніший = більше дій (відкриття, питання дня, новини).
            Порожні смуги показують перерви краще за будь-яке середнє.
          </Hint>
          <div className="mt-3.5 border-t border-glassb pt-3">
            <WeekdayBars cells={s.heatmap} />
            <Hint>
              Середня активність за днем тижня за всі 12 тижнів. Показує, який день у тебе
              системно провальний — це майже завжди той самий день, а не випадковість.
            </Hint>
          </div>
        </Card>
      )}
    </div>
  );
}
