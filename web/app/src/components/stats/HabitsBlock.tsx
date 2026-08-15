import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { haptic } from '../../telegram.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionHead, Hint } from '../ui/primitives.tsx';
import { useCountUp } from '../ui/CountUp.tsx';
import { Heatmap } from '../charts/Heatmap.tsx';
import { WeekdayBars } from '../charts/WeekdayBars.tsx';
import { OpenRhythm } from '../charts/OpenRhythm.tsx';
import { HabitTrend } from '../charts/HabitTrend.tsx';
import { FlameTrend } from '../charts/FlameTrend.tsx';
// Одна мова підписів глибини на весь екран: «ЗА N ТИЖНІВ», не «N ТИЖ.».
import { weeksWindowLabel } from '../../lib/windowLabel.ts';

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
  detail,
  gradient = false,
}: {
  n: number;
  emoji?: string;
  label: string;
  note?: string;
  /** Розбивка під тапом. Є — плитка стає кнопкою; немає — лишається текстом. */
  detail?: React.ReactNode;
  gradient?: boolean;
}) {
  // Стрік набігає від нуля (36px — рух видно здалеку). useInView — про запас.
  const [ref, inView] = useInView<HTMLDivElement>();
  const [open, setOpen] = useState(false);
  const shown = useCountUp(n, inView);
  // Плитка без розбивки лишається <div>: кнопка, що нічого не робить, гірша за
  // її відсутність — читач екрана оголосить її як інтерактивну.
  const Tag = detail ? 'button' : 'div';
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLButtonElement>}
      {...(detail
        ? {
            type: 'button' as const,
            'aria-expanded': open,
            onClick: () => {
              haptic('light');
              setOpen((v) => !v);
            },
          }
        : {})}
      className="flex flex-1 flex-col gap-0.5 rounded-2xl border border-glassb bg-glass p-3.5 text-left"
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
      {detail && open && (
        <span className="mt-1 border-t border-glassb pt-1 font-mono text-[9.5px] leading-[1.4] text-tx3">
          {detail}
        </span>
      )}
    </Tag>
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

  // Охоплення рахуємо з heatmap: там уже лежить кожна доба вікна, тож нове
  // поле в API для цього не потрібне.
  //
  // ⚠️ ПРЕДИКАТ — c.o > 0 («відкривав»), а НЕ c.v > 0 (opens+mock+news).
  // Доти в одному ряду стояли два лічильники з РІЗНИМИ дефініціями активності:
  // стрік ліворуч рахував відкриття, а цей — будь-яку з трьох подій, і ніщо про
  // це не казало. Два числа поруч читаються як одна величина, тож розбіжність
  // була невидимою за побудовою.
  //
  // Зведено до відкриттів, бо саме це людина розуміє під «активним днем», і
  // саме цим міряється сусідній стрік. Питання й новини без відкриття
  // застосунку однаково не трапляються — обидві події шле лише Mini App, яка
  // на кожному завантаженні шле ще й `open`.
  const totalDays = s.heatmap.length;
  const openedDays = s.heatmap.filter((c) => c.o > 0).length;
  const daysWithMock = s.heatmap.filter((c) => c.m > 0).length;
  const daysWithNews = s.heatmap.filter((c) => c.n > 0).length;

  const flames = s.flameStats;

  // Вікна не завжди рівно 12/26 тижнів — щойно запущений трекер росте від
  // моменту першого запису (stats-core.mjs: weeksAvailable), тож підпис
  // мусить показувати РЕАЛЬНУ глибину, а не завжди «12», інакше сам підпис
  // бреше, поки історія коротша за максимум.
  const heatmapWeeks = Math.ceil(s.heatmap.length / 7);

  return (
    // ⚠️ ЧОТИРИ ГРУПИ, розділені ВІДСТУПОМ, без заголовків груп.
    //
    // Доти порядок стрибав між масштабами без системи: година доби -> тижні ->
    // «зараз» -> доби + день тижня -> тижні. І дві пари, що відповідають на
    // ОДНЕ питання, стояли нарізно: «о котрій» і «в який день»; «тижнева
    // стабільність» і «добова».
    //
    // Тепер: СТАН («чи я тут зараз») -> РОЗКЛАД («коли я тут»: година, потім
    // день тижня) -> СТАЛІСТЬ («наскільки рівно»: доба, потім тиждень) ->
    // ПОЗА СВІТАНКОМ. Від дієвого до описового, від дрібного масштабу до
    // великого.
    //
    // Групи НЕ підписані навмисно: третій рівень заголовків на 375px тільки
    // додав би шуму. Групування читається ритмом — 26px між групами проти
    // 14px усередині.
    //
    // Порожні групи не рендеряться взагалі: інакше їх нульова висота лишила б
    // подвійний відступ там, де блоку немає.
    <div className="flex flex-col gap-[26px]">
      {/* ── СТАН: єдине, з чого випливає дія на СЬОГОДНІ. Тому вгорі, а не під
          двома графіками трендів, як було. Стріки описують «зараз», тренди —
          минуле, і минуле нікуди не поспішає. */}
      <div className="flex flex-col gap-3.5">
        <SectionHead>Звички</SectionHead>
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
            n={openedDays}
            label={`діб відкривав із ${totalDays}`}
            note={
              totalDays > 0
                ? `${Math.round((openedDays / totalDays) * 100)}% ВІД ПЕРШОГО ЗАПИСУ`
                : undefined
            }
            detail={
              openedDays > 0 ? (
                <>
                  з них із питаннями {daysWithMock} · з новинами {daysWithNews}
                </>
              ) : undefined
            }
          />
        </div>

        {has(s.streaks.bestOpenDays) && (
          <span className="-mt-1 font-mono text-[10px] font-semibold text-tx3">
            {cur >= best ? '🏆 Це вже рекорд!' : `До рекорду: ${best - cur} дн.`}
          </span>
        )}
      </div>

      {/* ── РОЗКЛАД: «коли я тут». Разом вони дають звʼязну картину ритму —
          «заходжу о 08:20 ± 22 хв, найактивніший день понеділок». Порізно це
          два не повʼязані факти на різних кінцях блоку. */}
      {(s.openRhythm.ready || showHeatmap) && (
        <div className="flex flex-col gap-3.5">
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
                інші. Вузька коробка означає ритуал, широка — що заходиш коли доведеться. Рахується
                по останніх {s.windows.rhythmOpens} добах із відкриттям, а не за весь час — інакше
                звичка, що змінилась пів року тому, тягнула б число на себе досі.
              </Hint>
            </Card>
          )}
          {showHeatmap && (
            <Card>
              <SubLabel>НАЙАКТИВНІШИЙ ДЕНЬ ТИЖНЯ · {weeksWindowLabel(heatmapWeeks)}</SubLabel>
              <div className="mt-2">
                <WeekdayBars cells={s.heatmap} />
              </div>
              <Hint>
                ТИПОВА активність за днем тижня — медіана, не середнє: один нетиповий день (довго
                щось налаштовував і відкривав апку десятки разів) інакше перетягнув би весь стовпчик
                на себе й видав випадковість за систему. Тонкий вус — розкид середньої половини
                таких днів: він відповідає на те, чого медіана сказати не може — чи різниця
                СТАБІЛЬНА, чи це два випадкові тижні. Підсвічено найактивніший день; найнижчий
                стовпчик — той, що системно провисає.
              </Hint>
            </Card>
          )}
        </div>
      )}

      {/* ── СТАЛІСТЬ: «наскільки рівно тримаюсь». Доба перед тижнем — від
          дрібного масштабу до великого, так само як «Форма дня» йде від ранку
          до вечора. */}
      {(showHeatmap || hw.length >= 2) && (
        <div className="flex flex-col gap-3.5">
          {showHeatmap && (
            <Card>
              <SubLabel>ЩОДЕННА АКТИВНІСТЬ · {weeksWindowLabel(heatmapWeeks)}</SubLabel>
              <div className="mt-2">
                <Heatmap cells={s.heatmap} />
              </div>
              <Hint>
                Кожен квадратик — доба, темніший = більше дій (відкриття, питання дня, новини).
                Порожні смуги показують перерви краще за будь-яке середнє.
              </Hint>
            </Card>
          )}
          {/* 2. УТРИМАННЯ — тренд, якого не було взагалі: теплокарта показує
              щільність, але не відповідає «чи я тримаюсь краще, ніж місяць тому». */}
          {hw.length >= 2 && (
            <Card>
              <div className="flex items-baseline gap-2">
                <SubLabel>УТРИМАННЯ · {weeksWindowLabel(hw.length)}</SubLabel>
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
                Два питання в одній картці, кожне у своїй геометрії. Стовпець — ОБСЯГ дій за тиждень
                відносно найактивнішого з показаних, кольори всередині — з чого він складався. Смуга
                під стовпцем — ПОКРИТТЯ: скільки діб тижня взагалі були активні. Розділені навмисно:
                два тижні з покриттям 5/5 однакові за покриттям, але можуть різнитись обсягом
                утричі, і однією висотою це не показати. Тапни на тиждень — покаже склад і
                порівняння з попереднім.
              </Hint>
            </Card>
          )}
        </div>
      )}

      {/* ⚠️ ТУТ БУВ <WeekBars days={s.weekly} /> — сім стовпчиків за останній
          тиждень. Прибраний на вимогу власника («не розумію, для чого він»), і
          три причини кажуть те саме.

          1. Дублював теплокарту гіршою мовою: та показує ті самі доби й ще
             пʼять тижнів, з АБСОЛЮТНОЮ шкалою кольору (пороги 1/3/6). WeekBars
             нормувався ВІДНОСНО СЕБЕ, тож тиждень з одним відкриттям на добу
             виглядав так само, як тиждень із двадцятьма.
          2. Кодував ІНШУ величину, ніж сусіднє «Утримання»: там висота це
             opens+mock+news, тут лише opens. Два зовні однакові стовпчикові
             графіки в одному блоці означали різне.
          3. Ні заголовка, ні підпису, ні одиниць, ні тапу — єдиний такий
             елемент на екрані, ще й на найдорожчому місці, одразу під
             лічильниками.

          Порожнеча тут навмисна: подих між лічильниками й теплокартою читається
          краще, ніж ще один графік. s.weekly лишається в контракті — його
          прибирання з сервера окрема задача, і без споживача воно не терміново. */}

      {/* 5. ВОГНИКИ — стріки в СТОРОННІХ застосунках (evening.flames). Свідомо
          тут, не в Чек-іні: це той самий тип сигналу, що opens/mock/news вище
          («чи тримаю звичку»), а не про добробут дня. */}
      {flames.tops.length > 0 && (
        <Card>
          <SubLabel>
            ВОГНИКИ В ІНШИХ ЗАСТОСУНКАХ · {weeksWindowLabel(flames.weekly.length)}
          </SubLabel>

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
            Стріки, які тримаєш поза Світанком. ⚠️ Дві плитки вгорі рахують РІЗНЕ: ліва — вечори, де
            горіли ВСІ пʼять, права — де горів хоч один. Перемикач над графіком показує ту саму
            різницю по тижнях: «хоч один» — чи тримаю звичку взагалі, «усі пʼять» — чи тримаю рутину
            повністю. Це різні цілі з різною ціною, тож вибір за тобою, а не за замовчуванням. Колір
            усередині стовпця — конструктивний вогник (навчання, гра розуму) чи споживчий (стрічка);
            частка конструктивних за весь період — числом праворуч від перемикача.
          </Hint>
          {/* ⚠️ ТУТ БУВ підблок «Що частіше пропускаю» — рейтинг застосунків за
              пропусками. Прибраний на вимогу власника, і дані підтверджують:

              дія з нього нульова (я й так знаю, що частіше забуваю Тікток), а
              на реальних даних усі пʼять рядків показували 11× — тобто
              ранжування ВИРОДЖЕНЕ, порядок випадковий, а смуги однакової
              довжини вдавали рейтинг там, де рейтингу немає.

              Головне тепер живе не тут, а в самому чек-іні: питання про вогники
              піднято у другий пункт вечора як НАГАДУВАННЯ їх запалити. Звіт про
              те, чого не запалив, ту саму роботу зробити не міг — він приходив
              тоді, коли день уже минув.

              flameStats.missedTops лишається в контракті. */}
        </Card>
      )}
    </div>
  );
}
