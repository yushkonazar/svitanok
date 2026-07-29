import type { ReactNode } from 'react';
import type { Stats } from '../../api/schema.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';

// Статистика чек-іну (фідбек власника, п.7 -> PR-9 п.10.2: «графіки для сну/
// енергії не потрібні, просто вивід середнього й подальший аналіз з
// рекомендацією; перероби блок і по дизайну, і по деяких логічних рішеннях»).
//
// Спарклайни Сон/Енергія ПРИБРАНО — замінено на одну картку «Сон та енергія»:
// середні + тренд (уже рахувались) + детермінована, правило-based рекомендація
// (не LLM — дешево, без нової затримки). Решта секцій нижче — явка, куди йде
// час, кореляції — ЛИШАЮТЬСЯ (вони вже anti-overfit-гейтяться на сервері й
// відповідають «аналіз, не графік»), лише отримали явні підписи там, де їх
// не було (явка) чи бракувало пояснення, ЩО означає число (куди йде час).
//
// ⚠️ Цей блок ЛЕГКО зробив би брехливим. «У дні, коли ти спав менше 6 — подач
// удвічі менше» звучить як висновок, а на третьому тижні це три точки проти
// чотирьох. І така брехня ВИГЛЯДАЄ як аналітика, тобто підштовхує до рішень.
// Тому все, що претендує на звʼязок, гейтиться на сервері (sleepVsApplied.ready)
// і мовчить, поки в кожному кошику менше 8 днів.

// Дзеркало переліків із questions.ts. Неповна мапа не валить екран (є фолбек
// на сирий слаг нижче), але показувала б «nomotiv» замість людського підпису.
const BLOCKER_LABEL: Record<string, string> = {
  tired: 'Втома',
  anxious: 'Тривога',
  stuck: 'Не знав з чого',
  distract: 'Відволікання',
  nomotiv: 'Немає мотивації',
  overload: 'Забагато всього',
  procrast: 'Відкладав',
  waiting: 'Чекав на інших',
  health: 'Здоровʼя',
  external: 'Зовнішнє',
};
const HELPER_LABEL: Record<string, string> = {
  early: 'Ранній старт',
  list: 'Список',
  smallstep: 'Маленький крок',
  nodistract: 'Прибрав відволікання',
  move: 'Рух/прогулянка',
  breaks: 'Перерви',
  deadline: 'Дедлайн',
  music: 'Музика/фокус',
  support: 'Підтримка',
};
const CATEGORY_LABEL: Record<string, string> = {
  work: '💼 Робота',
  learn: '📚 Навчання',
  project: '🛠 Проєкт',
  travel: '🧭 Дорога',
  chores: '🔁 Побут',
  sport: '🏃 Спорт',
  rest: '🌿 Відпочинок',
  people: '👥 Люди',
  create: '🎨 Творчість',
};

// Колір оцінки: червоний (погано) -> жовтий -> зелений (добре). Щоб число саме
// по собі казало «це добре чи ні», а не було просто цифрою.
const scoreHsl = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 125)}, 62%, 58%)`;
/** Шкала 1–5 (енергія, оцінка дня, настрій). */
const ratingColor = (v: number | null): string | undefined =>
  v == null ? undefined : scoreHsl((v - 1) / 4);
/** Сон у годинах: 4 і менше — червоне, 8+ — зелене (плато на «виспався»). */
const sleepColor = (h: number | null): string | undefined =>
  h == null ? undefined : scoreHsl((h - 4) / 4);

/** Число з кольором-оцінкою. */
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

/** Заголовок-підпис секції: моно-капс, що саме показує картка нижче. */
function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">{children}</div>
  );
}

/**
 * Рекомендація за середнім сном/енергією тижня — ДЕТЕРМІНОВАНА (пороги, не
 * LLM: дешево, без нової затримки/виклику). Пороги: сон 6/7 год (нижче
 * рекомендованих 7–9 — поширений орієнтир), енергія 2.5/4 на шкалі 1–5.
 * Свідомо ЗАГАЛЬНІ формулювання ("спробуй", "орієнтовно") — той самий
 * інваріант, що svd/bve нижче: не вигадувати причинно-наслідкових звʼязків,
 * яких дані не підтверджують.
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

export function CheckinBlock({ s }: { s: Stats }) {
  const series = s.checkinSeries;
  const fill = s.checkinFill;
  const filledDays = series.length;

  if (!filledDays)
    return (
      <div className="flex flex-col gap-3">
        <SectionHead>Чек-ін</SectionHead>
        <Ph>Заповни чек-ін кілька днів — і тут з’являться твої ряди</Ph>
      </div>
    );

  const sleepVals = series.map((p) => p.sleepH).filter((v): v is number => v !== null);
  const avgSleep = sleepVals.length
    ? Math.round((sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) * 10) / 10
    : null;

  const week = s.checkinWeekly.at(-1);
  const prev = s.checkinWeekly.at(-2);
  const trend =
    week?.sleepAvg != null && prev?.sleepAvg != null
      ? week.sleepAvg > prev.sleepAvg
        ? ' · ↑ vs минулий'
        : week.sleepAvg < prev.sleepAvg
          ? ' · ↓ vs минулий'
          : ' · = vs минулий'
      : '';
  const insight = checkinInsight(avgSleep, week?.energyAvg ?? null);

  const svd = s.sleepVsDayScore;
  const bve = s.bedtimeVsEnergy;
  const cat = s.categoryInsight;
  const drift = s.intentDrift;
  const cal = s.appliedCalibration;
  const tops = s.checkinTops;
  const kept = s.planVsFact;
  // «Намір проти факту» — джоб-опційне: показуємо лише коли були робочі дні.
  const keptHit = kept.filter((r) => r.actual >= r.planned).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Чек-ін</SectionHead>

      {/* Сон та енергія — БЕЗ графіків (фідбек власника, п.10.2): середні +
          тренд + детермінована рекомендація замість спарклайнів. */}
      <div className="flex flex-col gap-2 rounded-2xl border border-glassb bg-glass p-4">
        <SubLabel>СОН ТА ЕНЕРГІЯ · ЗА {filledDays} ДІБ</SubLabel>
        <div className="flex items-center gap-5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-tx3">СОН (СЕРЕДНЄ)</span>
            <Score
              v={avgSleep}
              color={sleepColor(avgSleep)}
              suffix=" год"
              className="font-mono text-[19px] font-semibold"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-tx3">ЕНЕРГІЯ (ЦЕЙ ТИЖДЕНЬ)</span>
            <Score
              v={week?.energyAvg ?? null}
              color={ratingColor(week?.energyAvg ?? null)}
              className="font-mono text-[19px] font-semibold"
            />
          </div>
        </div>
        {week && (
          <span className="text-[10.5px] font-medium text-tx2">
            Сон цього тижня:{' '}
            <Score v={week.sleepAvg} color={sleepColor(week.sleepAvg)} suffix=" год" />
            {trend}
          </span>
        )}
        {insight && (
          <div className="mt-0.5 text-[11.5px] leading-[1.5] text-tx2">💡 {insight}</div>
        )}
      </div>

      {/* Явка: пропуски — теж дані. Ранок 25 разів проти вечора 4 каже більше,
          ніж самі відповіді. */}
      <div className="flex flex-col gap-1">
        <SubLabel>ЯВКА ПО СЛОТАХ</SubLabel>
        <StatRow label="🌅 Ранок" value={`${fill.morning} з ${fill.days}`} />
        <StatRow label="☀️ Післяобід" value={`${fill.afternoon} з ${fill.days}`} />
        <StatRow label="🌙 Вечір" value={`${fill.evening} з ${fill.days}`} />
      </div>

      {/* Куди йде час (v2): розподіл денної категорії + як вона повʼязана з
          оцінкою дня. Розподіл чесний за будь-якого N; середню оцінку категорії
          даємо лише коли в неї набралось >=4 оцінені дні (інакше без числа). */}
      {cat.total >= 5 && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <SubLabel>КУДИ ЙДЕ ЧАС · {cat.total} ДІБ</SubLabel>
          {/* Пояснення, ЩО означає "настрій" у рядку — саме число без цього
              підпису незрозуміло, звідки й від чого воно рахується. */}
          <div className="mt-0.5 text-[10.5px] text-tx3">
            % часу за категорією за добу; «настрій» — середня оцінка дня в добах
            із цією категорією (лише коли їх ≥4)
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {cat.rows.slice(0, 4).map((r) => (
              <div key={r.cat} className="flex items-baseline gap-2 text-[13px]">
                <span className="font-semibold">{CATEGORY_LABEL[r.cat] ?? r.cat}</span>
                <span className="font-mono text-[11px] text-tx3">
                  {Math.round((r.n / cat.total) * 100)}%
                </span>
                {r.dayScore != null && (
                  <span className="ml-auto font-mono text-[11px] text-tx2">
                    настрій <Score v={r.dayScore} color={ratingColor(r.dayScore)} />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Дрейф наміру: план (ранок) проти того, що реально зайняло час (день).
          Обидва поля збирались роками й ніколи не порівнювались — тож ця
          картка працює з першого дня, не чекає накопичення нових полів.
          Гейт 5 діб — той самий мінімум, що й «куди йде час»: на трьох добах
          відсоток дотримання був би шумом у краватці. */}
      {drift.total >= 5 && drift.pct != null && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <SubLabel>ПЛАН ПРОТИ РЕАЛЬНОСТІ · {drift.total} ДІБ</SubLabel>
          <div className="mt-1.5 text-[13px] font-semibold">
            У {drift.pct}% діб день пішов за планом
            <span className="ml-1.5 font-mono text-[11px] font-medium text-tx3">
              {drift.matched} з {drift.total}
            </span>
          </div>
          {drift.top.length > 0 && (
            <>
              <div className="mt-2 text-[10.5px] text-tx3">Куди зʼїжджає найчастіше:</div>
              <div className="mt-1 flex flex-col gap-1">
                {drift.top.slice(0, 3).map((p) => (
                  <div key={`${p.from}>${p.to}`} className="flex items-baseline gap-1.5 text-[12px]">
                    <span className="text-tx2">{CATEGORY_LABEL[p.from] ?? p.from}</span>
                    <span className="text-tx3">→</span>
                    <span className="font-semibold">{CATEGORY_LABEL[p.to] ?? p.to}</span>
                    <span className="ml-auto font-mono text-[10.5px] text-tx3">×{p.n}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Сон -> оцінка дня. Кореляція лише коли є що порівнювати. */}
      <div className="rounded-2xl border border-glassb bg-glass p-4">
        <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
          СОН І ОЦІНКА ДНЯ
        </div>
        {svd.ready ? (
          <>
            <div className="mt-1.5 text-[13px] font-semibold">
              Спав &lt;6.5 год — оцінка дня{' '}
              <Score v={svd.lowAvg ?? null} color={ratingColor(svd.lowAvg ?? null)} />
            </div>
            <div className="text-[13px] font-semibold">
              Спав більше — <Score v={svd.okAvg ?? null} color={ratingColor(svd.okAvg ?? null)} />
            </div>
            <div className="mt-1 text-[10.5px] text-tx3">
              {svd.low} і {svd.ok} днів. Це спостереження, не причина.
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[12px] leading-[1.5] text-tx2">
            Ще рано порівнювати: {svd.low} коротких ночей і {svd.ok} нормальних, а треба
            щонайменше по {svd.needed}. На меншій вибірці будь-яка цифра тут була б
            вигадкою, тому її немає.
          </div>
        )}
      </div>

      {bve.ready && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            КОЛИ ЛЯГАЄШ І РАНКОВА ЕНЕРГІЯ
          </div>
          <div className="mt-1.5 text-[13px] font-semibold">
            Лягав рано (до 00:00) — енергія{' '}
            <Score v={bve.earlyAvg ?? null} color={ratingColor(bve.earlyAvg ?? null)} />
          </div>
          <div className="text-[13px] font-semibold">
            Пізно (після 01:00) —{' '}
            <Score v={bve.lateAvg ?? null} color={ratingColor(bve.lateAvg ?? null)} />
          </div>
          <div className="mt-1 text-[10.5px] text-tx3">
            {bve.early} і {bve.late} днів. Спостереження, не причина.
          </div>
        </div>
      )}

      {/* Що піднімає / тягне — мода за N діб. */}
      {tops.blocker && (
        <StatRow
          label="🚧 Найчастіше заважало"
          value={`${BLOCKER_LABEL[tops.blocker.value] ?? tops.blocker.value} · ${tops.blocker.n}×`}
        />
      )}
      {tops.helper && (
        <StatRow
          label="✨ Найчастіше допомагало"
          value={`${HELPER_LABEL[tops.helper.value] ?? tops.helper.value} · ${tops.helper.n}×`}
        />
      )}

      {/* Джоб-опційне — зʼявляється лише в дні пошуку роботи (є подачі в журналі
          / самозвіт). У «загальні» дні цих рядків просто немає. */}
      {kept.length > 0 && (
        <StatRow label="🎯 Виконав план подач" value={`${keptHit} з ${kept.length} днів`} />
      )}
      {cal.n > 0 && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            📊 ПОДАЧІ: ЗВІТ ↔ ЖУРНАЛ
          </div>
          <div className="mt-1.5 text-[13px] font-semibold">
            Збіглося {cal.matched} з {cal.n} днів
          </div>
          {(cal.more > 0 || cal.fewer > 0) && (
            <div className="mt-1 text-[10.5px] leading-[1.5] text-tx3">
              {cal.more > 0 && `${cal.more} дн. подавав поза застосунком`}
              {cal.more > 0 && cal.fewer > 0 && ' · '}
              {cal.fewer > 0 && `${cal.fewer} дн. у журналі більше`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
