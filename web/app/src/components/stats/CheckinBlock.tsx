import { useState, type ReactNode } from 'react';
import type { Stats } from '../../api/schema.ts';
import { SectionHead, StatRow, Ph, Hint, Note } from '../ui/primitives.tsx';
import { haptic } from '../../telegram.ts';
import { DayIndexHero } from './DayIndexHero.tsx';
import { DayShapeChart } from '../charts/DayShapeChart.tsx';
import { StateMatrix } from '../charts/StateMatrix.tsx';
import { DriversBars } from '../charts/DriversBars.tsx';
import { ArchetypeRadar } from '../charts/ArchetypeRadar.tsx';
import { RankedBars } from '../charts/RankedBars.tsx';
import { FillBars } from '../charts/FillBars.tsx';
import { INDEX_LABEL } from '../../lib/checkinIndex.ts';
// Підписи глибини малюються з s.windows (сервер), а не з памʼяті цього файлу.
import { daysWindowLabel } from '../../lib/windowLabel.ts';
// Підписи значень чек-іну — спільні з картою станів (lib/checkinLabels.ts).
// Доти вони жили тут локальними константами; щойно тих самих значень
// знадобилось деталям клітинки, дві копії почали б розходитись мовчки.
import {
  BLOCKER_LABEL,
  HELPER_LABEL,
  LATE_REASON_LABEL,
  WITH_WHOM_LABEL,
  CATEGORY_LABEL,
} from '../../lib/checkinLabels.ts';

// Статистика чек-іну — ПОВНИЙ редизайн (роадмеп: «Індекс дня» + D3-графіки).
// Стара версія (PR-9) читала 11 полів із 36 зібраних; ця — «Індекс дня»
// (checkin-model.mjs, портовано з research/checkin_model.py, golden-звірено)
// читає 25: композитні індекси, ваги, що вчаться на власних dayScore,
// драйвери (Cohen's d + Welch), лаговий звʼязок «сьогодні->завтра»,
// архетипи (k-means). П'ять нових візуальних секцій зверху — аналітичний
// шар; уся стара, уже коректна аналітика (куди йде час, дрейф наміру,
// кореляції, топ-блокери, калібрація подач) лишається під «Подробиці»,
// не викидається — просто більше не забиває головний екран.
//
// ⚠️ Той самий інваріант, що завжди: усе, що претендує на звʼязок, гейтиться
// на сервері (ready/learned/p-value) і мовчить, поки вибірка мала. Це легко
// зробити брехливим блоком, а брехня тут виглядає як аналітика.

const scoreHsl = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 125)}, 62%, 58%)`;
const ratingColor = (v: number | null): string | undefined =>
  v == null ? undefined : scoreHsl((v - 1) / 4);
const sleepColor = (h: number | null): string | undefined =>
  h == null ? undefined : scoreHsl((h - 4) / 4);

function Score({
  v,
  color,
  suffix = '',
  className = '',
}: {
  v: number | null;
  color: string | undefined;
  suffix?: string;
  className?: string;
}) {
  return (
    <span className={className} style={color ? { color } : undefined}>
      {v == null ? '—' : `${v}${suffix}`}
    </span>
  );
}

function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">{children}</div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-glassb bg-glass p-4">{children}</div>;
}

/**
 * Рекомендація за середнім сном/енергією тижня — ДЕТЕРМІНОВАНА (пороги, не
 * LLM): пороги сон 6/7 год, енергія 2.5/4 на шкалі 1..5. Свідомо загальні
 * формулювання — той самий інваріант, що весь блок: не вигадувати
 * причинно-наслідкових звʼязків, яких дані не підтверджують.
 */
function checkinInsight(avgSleep: number | null, weekEnergyAvg: number | null): string | null {
  const parts: string[] = [];
  if (avgSleep != null) {
    if (avgSleep < 6) parts.push('Сон нижче рекомендованого — спробуй лягати на 30–60 хв раніше.');
    else if (avgSleep < 7) parts.push('Сон трохи нижче рекомендованих 7–9 год.');
    else parts.push('Сон у нормі — тримай цей режим.');
  }
  if (weekEnergyAvg != null) {
    if (weekEnergyAvg < 2.5) parts.push('Енергія цього тижня низька.');
    else if (weekEnergyAvg >= 4) parts.push('Енергія цього тижня висока.');
  }
  return parts.length ? parts.join(' ') : null;
}

/** «Сьогодні -> завтра»: лаговий звʼязок, єдине, що дивиться на ЗАВТРАШНІЙ день. */
function LaggedRow({ idx, data }: { idx: string; data: Stats['checkinModel']['lagged'][string] }) {
  if (!data.ready) {
    return (
      <div className="text-[11px] leading-[1.5] text-tx3">
        {INDEX_LABEL[idx] ?? idx}: ще рано ({data.n} із {data.needed} потрібних пар діб).
      </div>
    );
  }
  const rho = data.rho ?? 0;
  const sig = (data.p ?? 1) < 0.05;
  const dir = rho > 0.05 ? '↑ вищий' : rho < -0.05 ? '↓ нижчий' : 'без помітного звʼязку';
  return (
    <div className="flex items-baseline gap-1.5 text-[12px]">
      <span className="font-semibold text-tx">{INDEX_LABEL[idx] ?? idx}</span>
      <span className="text-tx2">
        сьогодні → {dir === 'без помітного звʼязку' ? dir : `завтрашній день ${dir}`}
      </span>
      <span className="ml-auto font-mono text-[10px] text-tx3">
        ρ={rho.toFixed(2)} {sig ? '· значущо' : '· шум?'}
      </span>
    </div>
  );
}

/** «Сам» проти «з людьми»: той самий тон, що LaggedRow — Cohen's d + Welch p. */
function AloneVsOthersRow({ data }: { data: Stats['socialContext']['aloneVsOthers'] }) {
  if (!data.ready) {
    return (
      <div className="text-[11px] leading-[1.5] text-tx3">
        Порівняння «сам / з людьми» ще рано ({data.nAlone} і {data.nOthers} із {data.needed}{' '}
        потрібних діб у кожному кошику).
      </div>
    );
  }
  const alone = data.aloneAvg ?? 0;
  const others = data.othersAvg ?? 0;
  const sig = (data.p ?? 1) < 0.05;
  const dir = alone > others ? 'ЗАЗВИЧАЙ ВИЩА' : alone < others ? 'ЗАЗВИЧАЙ НИЖЧА' : 'БЕЗ РІЗНИЦІ';
  return (
    <div className="flex items-baseline gap-1.5 text-[12px]">
      <span className="whitespace-nowrap font-semibold text-tx">🧍 Сам</span>
      <span className="text-tx2">оцінка дня {dir}, ніж коли серед людей</span>
      <span className="ml-auto font-mono text-[10px] text-tx3">
        d={(data.d ?? 0).toFixed(2)} {sig ? '· значущо' : '· шум?'}
      </span>
    </div>
  );
}

export function CheckinBlock({ s }: { s: Stats }) {
  const series = s.checkinSeries;
  const model = s.checkinModel;
  const filledDays = series.length;
  const [detailsOpen, setDetailsOpen] = useState(false);

  // ⚠️ Гейт БЕЗ model.n, і це виправлення, а не спрощення. `model.n` — це
  // довжина плаского масиву, який buildCheckinModel будує ЗАВЖДИ на повні 90
  // ітерацій, вставляючи порожні доби. Тобто воно дорівнює вікну, а не
  // кількості заповнених діб, і `model.n === 0` було ІСТИННЕ лише тоді, коли
  // сервер узагалі не віддав поле (застарілий воркер -> zod-дефолт).
  //
  // Наслідок: абсолютно новий користувач НІКОЛИ не бачив цієї заглушки —
  // натомість йому рендерилась секція з порожньою картою станів. Заповнених діб
  // достатньо як єдиної умови: немає жодної — показувати нічого.
  if (!filledDays) {
    return (
      <div className="flex flex-col gap-3">
        <SectionHead>Чек-ін</SectionHead>
        <Ph>Заповни чек-ін кілька днів — і тут з’явиться твій «Індекс дня»</Ph>
      </div>
    );
  }

  const sleepVals = series.map((p) => p.sleepH).filter((v): v is number => v !== null);
  const avgSleep = sleepVals.length
    ? Math.round((sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) * 10) / 10
    : null;
  const week = s.checkinWeekly.at(-1);
  const insight = checkinInsight(avgSleep, week?.energyAvg ?? null);

  // Точний сон (Блок «Сон») — найсвіжіша ніч ІЗ ОБОМА таймстемпами (тап «Ліг
  // спати» + автоматичне «прокинувся»). Половинчата ніч (лише один бік) не
  // показується — краще нічого, ніж здогадка з одного таймстемпу.
  const lastSleepNight = [...s.sleepLog].reverse().find((n) => n.durationMin != null);
  const kyivTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('uk-UA', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      minute: '2-digit',
    });
  const fmtDuration = (min: number) => `${Math.floor(min / 60)}год ${min % 60}хв`;

  const fill = s.checkinFill;
  // s.sleepVsDayScore / s.bedtimeVsEnergy СВІДОМО не читаються: sleepH і
  // bedtime тепер у реєстрі «Індексу дня», і DriversBars показує їхній вплив
  // строгіше (Cohen's d + Welch). Поля лишаються в контракті /api/stats —
  // прибирати їх із сервера немає причин, але малювати вдруге теж.
  const cat = s.categoryInsight;
  const drift = s.intentDrift;
  const cal = s.expectCalibration;
  const mv = s.moveIntent;
  const tops = s.checkinTops;
  const social = s.socialContext;

  const laggedEntries = Object.entries(model.lagged);

  // Періоди карти станів — із ОГОЛОШЕНИХ сервером вікон, не з літералів.
  // Ширших за гаряче вікно тут бути не може: глибших даних клієнт не має
  // (стеля 90 діб — це CPU-бюджет воркера), а кнопка, яка обіцяє період і
  // показує ті самі дані, гірша за її відсутність. Коли зʼявляться місячні
  // згортки, до цього ж масиву додасться «рік».
  const statePeriods = [
    { days: s.windows.checkinRecent, label: `${s.windows.checkinRecent}д` },
    { days: s.windows.checkinDeep, label: `${s.windows.checkinDeep}д` },
  ].filter((p, i, all) => all.findIndex((x) => x.days === p.days) === i);

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Чек-ін</SectionHead>

      {model.dayIndex.last !== null && (
        <Card>
          <DayIndexHero model={model} />
        </Card>
      )}

      {insight && <div className="text-[11.5px] leading-[1.5] text-tx2">💡 {insight}</div>}
      {lastSleepNight?.durationMin != null && lastSleepNight.startedAt && lastSleepNight.wokeAt && (
        <div className="text-[11.5px] leading-[1.5] text-tx2">
          🌙 Точний сон: {fmtDuration(lastSleepNight.durationMin)} (ліг о{' '}
          {kyivTime(lastSleepNight.startedAt)}, прокинувся о {kyivTime(lastSleepNight.wokeAt)})
        </div>
      )}

      {filledDays > 1 && (
        <Card>
          <SubLabel>ФОРМА ДНЯ · {daysWindowLabel(s.windows.checkinRecent, filledDays)}</SubLabel>
          <div className="mt-2">
            <DayShapeChart series={series} />
          </div>
          <Hint>
            Твій СЕРЕДНІЙ день від ранку до вечора. Показує те, чого середнє число сказати не
            може: ти згоряєш надвечір чи навпаки розганяєшся. Лінія вниз — енергія витікає до
            вечора.
          </Hint>
        </Card>
      )}

      <Card>
        <SubLabel>КАРТА СТАНІВ</SubLabel>
        {/* Глибина підписана ВСЕРЕДИНІ графіка, а не тут: вона тепер залежить
            від вибраного періоду, і рознесені підпис із перемикачем розійшлись
            би при першому ж кліку. */}
        <div className="mt-2">
          <StateMatrix raw={s.checkinRaw} periods={statePeriods} />
        </div>
        <Hint>
          Та сама сітка 5×5, по якій ти тапаєш у чек-іні. Число в клітинці — скільки разів ти в
          ній опинявся. Праворуч-угорі — бадьорий і в настрої, ліворуч-унизу — виснажений.
          Перемикач зверху розділяє ранок, день і вечір: це різні стани з різними причинами, і
          разом вони змішувались в одну купу.
        </Hint>
      </Card>

      {model.drivers.length > 0 && (
        <Card>
          <SubLabel>ЩО ЗСУВАЄ ОЦІНКУ ДНЯ</SubLabel>
          <div className="mt-2.5">
            <DriversBars drivers={model.drivers} />
          </div>
        </Card>
      )}

      {model.archetypes.ready && (
        <Card>
          <SubLabel>АРХЕТИПИ ДНІВ</SubLabel>
          <div className="mt-2.5">
            <ArchetypeRadar archetypes={model.archetypes} />
          </div>
          <Hint>
            «Середнього дня» не існує — натомість твої доби згруповані в кілька типів. Кожна
            фігура — форма одного типу за пʼятьма вимірами, відсоток — як часто такі дні
            трапляються. Чим більший промінь, тим сильніший вимір.
          </Hint>
        </Card>
      )}

      {laggedEntries.length > 0 && (
        <Card>
          <SubLabel>СЬОГОДНІ → ЗАВТРА</SubLabel>
          <div className="mt-2 flex flex-col gap-1.5">
            {laggedEntries.map(([idx, data]) => (
              <LaggedRow key={idx} idx={idx} data={data} />
            ))}
          </div>
          <Hint>
            Єдине місце, що дивиться на ЗАВТРАШНІЙ день: чи сьогоднішнє відновлення й рух
            повʼязані з тим, як мине наступна доба. ρ — сила звʼязку від −1 до +1 (0 — звʼязку
            немає). «Шум?» означає, що вибірки поки замало, щоб вірити числу.
          </Hint>
        </Card>
      )}

      <button
        type="button"
        onClick={() => {
          haptic('light');
          setDetailsOpen((v) => !v);
        }}
        className="flex items-center gap-1.5 self-start rounded-full border border-glassb bg-glass px-3 py-1.5 text-[11px] font-semibold text-tx2"
      >
        <span>{detailsOpen ? '−' : '+'} Подробиці</span>
      </button>

      {detailsOpen && (
        <div className="flex flex-col gap-3 border-t border-glassb pt-3">
          {/* ⚠️ Тут свідомо НЕМАЄ карток «Сон і оцінка дня» та «Коли лягаєш і
              ранкова енергія». Обидві були рукописними кореляціями по полях
              sleepH/bedtime — а обидва поля тепер у реєстрі «Індексу дня», і
              «Що зсуває оцінку дня» показує їх СТРОГІШЕ: Cohen's d + Welch
              замість різниці двох середніх. Лишати їх означало б показувати
              той самий звʼязок двічі, причому слабшою математикою.
              Що лишилось тут — рівно те, чого модель НЕ бачить. */}

          {/* Гейта не було зовсім: при трьох нулях картка малювала три порожні
              стовпчики, а «найслабший слот» вибирався довільно між ними —
              підсвічений червоним нуль там, де слотів просто ще не було. */}
          {fill.morning + fill.afternoon + fill.evening > 0 && (
            <Card>
              <SubLabel>ЯВКА ПО СЛОТАХ · {daysWindowLabel(fill.days)}</SubLabel>
              <div className="mt-2">
                <FillBars fill={fill} raw={s.checkinRaw} />
              </div>
            </Card>
          )}

          {/* blocker/helper — мультивибір, їх немає в реєстрі моделі за
              побудовою. Доти показувалась лише мода (одне значення), тепер —
              весь рейтинг: «втома 6× і відволікання 4×» — інша картина, ніж
              просто «найчастіше втома». */}
          {(tops.blockers.length > 0 || tops.helpers.length > 0) && (
            <Card>
              <SubLabel>ЩО ЗАВАЖАЛО І ЩО ПОМАГАЛО · {daysWindowLabel(tops.days, tops.filled)}</SubLabel>
              {tops.blockers.length > 0 && (
                <div className="mt-2.5">
                  <div className="mb-1.5 text-[11px] font-semibold text-tx2">🚧 Заважало</div>
                  <RankedBars
                    color="var(--color-neg)"
                    rows={tops.blockers.map((r) => ({
                      key: r.value,
                      label: BLOCKER_LABEL[r.value] ?? r.value,
                      n: r.n,
                    }))}
                  />
                </div>
              )}
              {tops.helpers.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[11px] font-semibold text-tx2">✨ Помагало</div>
                  <RankedBars
                    color="var(--color-pos)"
                    rows={tops.helpers.map((r) => ({
                      key: r.value,
                      label: HELPER_LABEL[r.value] ?? r.value,
                      n: r.n,
                    }))}
                  />
                </div>
              )}
              {/* ⚠️ «ЖОДНОГО РАЗУ» — не декор, а відповідь на питання «які
                  варіанти зайві», яке доти можна було вирішити тільки
                  здогадкою. Здогадка тут дорога в обидва боки: викинути
                  варіант, що трапляється раз на місяць, — назавжди втратити
                  рідкісну причину; лишити мертвий — щовечора платити за нього
                  увагою. Тепер відповідь дають дані, і рішення ухвалюється,
                  коли варіант простояв порожнім усе вікно. */}
              {(tops.unusedBlockers.length > 0 || tops.unusedHelpers.length > 0) && (
                <div className="mt-3 border-t border-glassb pt-2">
                  <div className="text-[10px] font-medium text-tx3">
                    Жодного разу за {tops.days} діб:{' '}
                    {[
                      ...tops.unusedBlockers.map((v) => BLOCKER_LABEL[v] ?? v),
                      ...tops.unusedHelpers.map((v) => HELPER_LABEL[v] ?? v),
                    ].join(' · ')}
                  </div>
                </div>
              )}
              <Hint>
                Скільки діб ти обирав кожен варіант. «Нічого» не рахується — це свідома відповідь,
                а не причина. Рядок «жодного разу» показує варіанти, які за все вікно не обрано —
                це підстава прибрати їх зі списку, коли вони простоять порожніми досить довго.
              </Hint>
            </Card>
          )}

          {/* lateReason — умовне ранкове поле (питається лише коли лягав
              пізно). Причина-тег, не скалярне поле, тож поза реєстром моделі
              за тією ж логікою, що blocker/helper вище. */}
          {tops.lateReasons.length > 0 && (
            <Card>
              <SubLabel>ЧОМУ ЛЯГАЄШ ПІЗНО · {tops.lateNights} НОЧЕЙ</SubLabel>
              <div className="mt-2">
                <RankedBars
                  color="var(--color-idx-recovery)"
                  rows={tops.lateReasons.map((r) => ({
                    key: r.value,
                    label: LATE_REASON_LABEL[r.value] ?? r.value,
                    n: r.n,
                  }))}
                />
              </div>
              <Hint>
                Питається лише в добу, коли ти ліг після півночі (01:00+). Показує, що ЗАЗВИЧАЙ
                стоїть за пізнім відбоєм — робота, стрічка чи просто не спиться.
              </Hint>
            </Card>
          )}

          {/* withWhom — соціальний контекст (afternoon, deep). Частота +
              справжнє порівняння «сам» проти «з людьми» на оцінці дня
              (Cohen's d + Welch, той самий апарат, що «Що зсуває оцінку
              дня» — не слабша математика лише тому, що поле поза реєстром
              моделі). */}
          {social.tops.length > 0 && (
            <Card>
              <SubLabel>СОЦІАЛЬНИЙ КОНТЕКСТ · {daysWindowLabel(social.days, social.filled)}</SubLabel>
              <div className="mt-2">
                <RankedBars
                  rows={social.tops.map((r) => ({
                    key: r.value,
                    label: WITH_WHOM_LABEL[r.value] ?? r.value,
                    n: r.n,
                  }))}
                />
              </div>
              <div className="mt-2.5 border-t border-glassb pt-2.5">
                <AloneVsOthersRow data={social.aloneVsOthers} />
              </div>
              <Hint>
                З ким переважно був день. Рядок знизу — чи «сам-на-сам» дні статистично
                відрізняються оцінкою від днів серед людей: d — сила різниці, «шум?» означає, що
                вибірки поки замало, щоб вірити числу.
              </Hint>
            </Card>
          )}

          {cat.total >= 5 && (
            <Card>
              <SubLabel>КУДИ ЙДЕ ЧАС · {daysWindowLabel(cat.days, cat.total)}</SubLabel>
              <div className="mt-2">
                <RankedBars
                  suffix=" діб"
                  rows={cat.rows.slice(0, 5).map((r) => ({
                    key: r.cat,
                    label: CATEGORY_LABEL[r.cat] ?? r.cat,
                    n: r.n,
                    note: r.dayScore != null ? `оцінка ${r.dayScore}` : null,
                    noteColor: ratingColor(r.dayScore),
                  }))}
                />
              </div>
              <Hint>
                Куди реально йде час: скільки діб кожна категорія забирала день. «Оцінка» —
                середня оцінка дня в таких добах, тобто які заняття корелюють із хорошим днем;
                зʼявляється лише від 4 оцінених діб.
              </Hint>
            </Card>
          )}

          {drift.total >= 5 && drift.pct != null && (
            <Card>
              <SubLabel>ПЛАН ПРОТИ РЕАЛЬНОСТІ · {daysWindowLabel(drift.days, drift.total)}</SubLabel>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className="font-mono text-[22px] font-medium leading-none"
                  style={{ color: ratingColor(1 + (drift.pct / 100) * 4) }}
                >
                  {drift.pct}%
                </span>
                {/* ⚠️ Формулювання змінилось разом із числом. Доти було «діб
                    пішли за планом» при критерії «збігся бодай один пункт із
                    двох» — тобто підпис стверджував більше, ніж міряло число.
                    Тепер обидва про одне: середня частка виконаного плану. */}
                <span className="text-[11.5px] text-tx2">
                  плану виконано в середньому
                  <span className="ml-1 font-mono text-tx3">
                    повністю {drift.full}/{drift.total}
                    {drift.partial > 0 && ` · частково ${drift.partial}`}
                  </span>
                </span>
              </div>
              {drift.top.length > 0 && (
                <div className="mt-2.5">
                  <div className="mb-1.5 text-[11px] font-semibold text-tx2">
                    Куди зʼїжджає найчастіше
                  </div>
                  <RankedBars
                    color="var(--color-idx-agency)"
                    rows={drift.top.slice(0, 4).map((p) => ({
                      key: `${p.from}>${p.to}`,
                      label: `${CATEGORY_LABEL[p.from] ?? p.from} → ${CATEGORY_LABEL[p.to] ?? p.to}`,
                      n: p.n,
                    }))}
                  />
                </div>
              )}
              <Hint>
                Уранці ти обираєш «головне на сьогодні», удень — «що зайняло час». Тут вони
                зіставлені. Число — СЕРЕДНЯ ЧАСТКА виконаного плану: два планові пункти й
                один зроблений дають 50%, а не 100%. Поруч — скільки діб пішли за планом
                повністю. Пари внизу — найчастіші підміни, тобто куди насправді витікає
                час; пара, що трапилась один раз, у список не потрапляє.
              </Hint>
            </Card>
          )}

          {/* ⚠️ ЄДИНИЙ СПОЖИВАЧ dayExpect. Поле навмисно не входить у жоден
              індекс моделі: воно про ПРОГНОЗ доби, а не про саму добу, і
              змішати їх означало б зробити «Індекс дня» частково передбаченням
              самого себе. Без цієї картки питання збиралось би в пусту. */}
          {cal.ready ? (
            <Card>
              <SubLabel>ОЧІКУВАННЯ ПРОТИ РЕАЛЬНОСТІ · {daysWindowLabel(cal.days, cal.n)}</SubLabel>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className="font-mono text-[22px] font-medium leading-none"
                  style={{
                    color:
                      (cal.bias ?? 0) > 0.2
                        ? 'var(--color-pos)'
                        : (cal.bias ?? 0) < -0.2
                          ? 'var(--color-neg)'
                          : undefined,
                  }}
                >
                  {(cal.bias ?? 0) > 0 ? '+' : ''}
                  {cal.bias}
                </span>
                <span className="text-[11.5px] text-tx2">
                  {(cal.bias ?? 0) > 0.2
                    ? 'дні виходять кращими, ніж очікуєш'
                    : (cal.bias ?? 0) < -0.2
                      ? 'дні виходять гіршими, ніж очікуєш'
                      : 'очікування збігається з реальністю'}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-tx3">
                <span>очікував {cal.avgExpect}</span>
                <span>вийшло {cal.avgActual}</span>
                <span>краще {cal.better}</span>
                <span>так само {cal.same}</span>
                <span>гірше {cal.worse}</span>
              </div>
              <Hint>
                Ранкове «яким очікуєш день» проти вечірньої оцінки. Число — СЕРЕДНІЙ зсув:
                додатний означає, що дні виходять кращими за прогноз. Три кошики поруч не
                зайві: нульовий зсув буває і коли щодня влучаєш, і коли половина днів краща,
                а половина гірша — це різні історії. Рахується від {cal.n} діб, де є обидві
                відповіді.
              </Hint>
            </Card>
          ) : (
            cal.n > 0 && (
              <Card>
                <SubLabel>ОЧІКУВАННЯ ПРОТИ РЕАЛЬНОСТІ</SubLabel>
                <Note>
                  Потрібно {cal.needed} діб, де є і ранкове очікування, і вечірня оцінка —
                  зараз {cal.n}. На меншій вибірці «ти песиміст» було б монеткою.
                </Note>
              </Card>
            )
          )}

          {/* Пара «намір проти факту» для руху. movePlan сам по собі живить
              лише BODY; без цієї картки звʼязок із вечірнім `moved` ніхто б
              не побачив. */}
          {mv.ready ? (
            <Card>
              <SubLabel>РУХ: НАМІР ПРОТИ ФАКТУ · {daysWindowLabel(mv.days, mv.n)}</SubLabel>
              <div className="mt-2 flex flex-col gap-1">
                <StatRow
                  label="Намір збувся"
                  value={
                    mv.keptPct === null ? (
                      <span className="font-normal text-tx3">планів не було</span>
                    ) : (
                      <>
                        {mv.keptPct}%
                        <span className="ml-1.5 font-normal text-tx3">
                          {mv.kept}/{mv.planned}
                        </span>
                      </>
                    )
                  }
                />
                <StatRow
                  label="Рух без плану"
                  value={
                    <>
                      {mv.noPlanButMoved}
                      <span className="ml-1.5 font-normal text-tx3">із {mv.noPlanDays}</span>
                    </>
                  }
                />
              </div>
              <Hint>
                Ранкове «рух заплановано?» проти вечірнього «рух сьогодні». Намір рахується
                виконаним, коли факт не НИЖЧИЙ за план: планував легкий рух, вийшло
                тренування — це виконано. Другий рядок про протилежне: скільки разів рух
                стався там, де його не планував. Зводити обидва в один відсоток означало б
                втратити половину картини.
              </Hint>
            </Card>
          ) : (
            mv.n > 0 && (
              <Card>
                <SubLabel>РУХ: НАМІР ПРОТИ ФАКТУ</SubLabel>
                <Note>
                  Потрібно {mv.needed} діб, де є і ранковий намір, і вечірній факт — зараз{' '}
                  {mv.n}.
                </Note>
              </Card>
            )
          )}

          {/* ⚠️ ТУТ БУЛА КАРТКА «ПОДАЧІ: СЛОВА ↔ ЖУРНАЛ» — прибрана на вимогу
              власника, і причина глибша за «подач поки мало».

              Вона зіставляла самозвіт про подачі з журналом appliedLog, тобто
              відповідала на питання ПРО ЯКІСТЬ ДАНИХ («наскільки точний мій
              самозвіт»), а не про пошук роботи. Такому місце в діагностиці, а
              не на екрані, куди приходять із питанням «що робити далі» —
              навіть коли подач стане тридцять.

              Дані нікуди не діваються: appliedCalibration і далі їде в
              /api/stats, і звірка лишається доступною тому, кому вона потрібна
              (щотижневий звіт асистента — саме той споживач). Прибрано лише
              постійне місце на екрані. */}

          {avgSleep !== null && (
            <StatRow
              label="😴 Сон (середнє за ряд)"
              value={<Score v={avgSleep} color={sleepColor(avgSleep)} suffix=" год" />}
            />
          )}
        </div>
      )}
    </div>
  );
}
