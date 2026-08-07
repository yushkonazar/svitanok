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
import { FlameTrend } from '../charts/FlameTrend.tsx';
import { RankedBars } from '../charts/RankedBars.tsx';

const FLAME_LABEL: Record<string, string> = {
  tiktok: 'Тікток',
  duolingo: 'Дуолінго',
  snapchat: 'Снепчат',
  bereal: 'BeReal',
  chess: 'Шахмати',
};

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

  // Охоплення рахуємо з heatmap: там уже лежить кожна доба вікна (v>0 = день
  // із дією), тож нове поле в API для цього не потрібне.
  const totalDays = s.heatmap.length;
  const activeDays = s.heatmap.filter((c) => c.v > 0).length;

  const flames = s.flameStats;

  // Вікна не завжди рівно 12/26 тижнів — щойно запущений трекер росте від
  // моменту першого запису (stats-core.mjs: weeksAvailable), тож підпис
  // мусить показувати РЕАЛЬНУ глибину, а не завжди «12», інакше сам підпис
  // бреше, поки історія коротша за максимум.
  const heatmapWeeks = Math.ceil(s.heatmap.length / 7);

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
            <SubLabel>УТРИМАННЯ · {hw.length} ТИЖ.</SubLabel>
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
            Висота стовпця — скільки дій зробив за тиждень відносно найактивнішого з показаних.
            Кольори всередині — з чого та активність складалась. Тапни на тиждень, щоб побачити
            числа (і скільки діб тижня був активним).
          </Hint>
        </Card>
      )}

      {/* 3. СТРІКИ — наслідок ритуалу, тому нижче, а не зверху.
          Друга плитка — ОХОПЛЕННЯ, а не стрік питання дня: той уже показується
          на вкладці «Сьогодні» в самій картці питання (фідбек власника), і
          дублювати його тут — витрачати найпомітніше місце блоку на повтор.
          Охоплення ж ніде не показувалось і дає стріку знаменник: 5 днів
          поспіль при 70 активних добах із 84 і при 20 — це різні історії. */}
      <div className="flex gap-2.5">
        <Tile
          gradient
          n={cur}
          emoji="🔥"
          label="днів поспіль відкрито"
          note={has(s.streaks.bestOpenDays) ? `РЕКОРД ${best}` : undefined}
        />
        <Tile
          n={activeDays}
          label={`активних діб із ${totalDays}`}
          note={totalDays > 0 ? `${Math.round((activeDays / totalDays) * 100)}% ЧАСУ` : undefined}
        />
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
          <SubLabel>ЩОДЕННА АКТИВНІСТЬ · {heatmapWeeks} ТИЖ.</SubLabel>
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
              ТИПОВА активність за днем тижня за {heatmapWeeks} тиж. — медіана, не середнє: один
              нетиповий день (довго щось налаштовував і відкривав апку десятки разів) інакше
              перетягнув би весь стовпчик на себе й видав випадковість за систему. Підсвічено
              найактивніший день; найнижчий стовпчик — той, що системно провисає.
            </Hint>
          </div>
        </Card>
      )}

      {/* 5. ВОГНИКИ — стріки в СТОРОННІХ застосунках (evening.flames). Свідомо
          тут, не в Чек-іні: це той самий тип сигналу, що opens/mock/news вище
          («чи тримаю звичку»), а не про добробут дня. */}
      {flames.tops.length > 0 && (
        <Card>
          <SubLabel>ВОГНИКИ В ІНШИХ ЗАСТОСУНКАХ · {flames.weekly.length} ТИЖ.</SubLabel>

          {/* Ідея поля — памʼятати заходити у ВСІ застосунки, не скільки
              разів обирав який (той лічильник тривіальний: коли flames
              взагалі відповідають, це майже завжди всі пʼять разом). */}
          <div className="mt-2 flex gap-2.5">
            <Tile
              gradient
              n={flames.streak}
              emoji="🔥"
              label="днів поспіль повна рутина"
              note={has(flames.best) ? `РЕКОРД ${flames.best}` : undefined}
            />
            <Tile n={flames.activeNights} label="вечорів хоч один вогник" />
          </div>
          {has(flames.best) && (
            <span className="-mb-1 mt-1.5 block font-mono text-[10px] font-semibold text-tx3">
              {flames.streak >= flames.best
                ? '🏆 Це вже рекорд!'
                : `До рекорду: ${flames.best - flames.streak} дн.`}
            </span>
          )}

          <div className="mt-3.5">
            <FlameTrend weeks={flames.weekly} />
          </div>
          <Hint>
            Стріки, які тримаєш поза Світанком. Висота стовпця — скільки вечорів тижня хоч один
            вогник горів; колір усередині — конструктивний він (навчання, гра розуму) чи споживчий
            (стрічка).
          </Hint>
          <div className="mt-3.5 border-t border-glassb pt-3">
            <div className="mb-1.5 text-[11px] font-semibold text-tx2">Що частіше пропускаю</div>
            <RankedBars
              rows={flames.missedTops.map((r) => ({
                key: r.value,
                label: FLAME_LABEL[r.value] ?? r.value,
                n: r.n,
              }))}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
