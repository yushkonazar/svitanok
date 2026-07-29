import { useState, type ReactNode } from 'react';
import type { Stats } from '../../api/schema.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';
import { haptic } from '../../telegram.ts';
import { DayIndexHero } from './DayIndexHero.tsx';
import { DayShapeChart } from '../charts/DayShapeChart.tsx';
import { StateMatrix } from '../charts/StateMatrix.tsx';
import { DriversBars } from '../charts/DriversBars.tsx';
import { ArchetypeRadar } from '../charts/ArchetypeRadar.tsx';
import { RankedBars } from '../charts/RankedBars.tsx';
import { FillBars } from '../charts/FillBars.tsx';
import { INDEX_LABEL } from '../../lib/checkinIndex.ts';

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

export function CheckinBlock({ s }: { s: Stats }) {
  const series = s.checkinSeries;
  const model = s.checkinModel;
  const filledDays = series.length;
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!filledDays && model.n === 0) {
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

  const fill = s.checkinFill;
  // s.sleepVsDayScore / s.bedtimeVsEnergy СВІДОМО не читаються: sleepH і
  // bedtime тепер у реєстрі «Індексу дня», і DriversBars показує їхній вплив
  // строгіше (Cohen's d + Welch). Поля лишаються в контракті /api/stats —
  // прибирати їх із сервера немає причин, але малювати вдруге теж.
  const cat = s.categoryInsight;
  const drift = s.intentDrift;
  const cal = s.appliedCalibration;
  const tops = s.checkinTops;
  const kept = s.planVsFact;
  const keptHit = kept.filter((r) => r.actual >= r.planned).length;

  const laggedEntries = Object.entries(model.lagged);

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Чек-ін</SectionHead>

      {model.dayIndex.last !== null && (
        <Card>
          <DayIndexHero model={model} />
        </Card>
      )}

      {insight && <div className="text-[11.5px] leading-[1.5] text-tx2">💡 {insight}</div>}

      {filledDays > 1 && (
        <Card>
          <SubLabel>ФОРМА ДНЯ</SubLabel>
          <div className="mt-2">
            <DayShapeChart series={series} />
          </div>
        </Card>
      )}

      <Card>
        <SubLabel>КАРТА СТАНІВ</SubLabel>
        <div className="mt-2">
          <StateMatrix series={series} />
        </div>
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

          <Card>
            <SubLabel>ЯВКА ПО СЛОТАХ · {fill.days} ДІБ</SubLabel>
            <div className="mt-2">
              <FillBars fill={fill} />
            </div>
          </Card>

          {/* blocker/helper — мультивибір, їх немає в реєстрі моделі за
              побудовою. Доти показувалась лише мода (одне значення), тепер —
              весь рейтинг: «втома 6× і відволікання 4×» — інша картина, ніж
              просто «найчастіше втома». */}
          {(tops.blockers.length > 0 || tops.helpers.length > 0) && (
            <Card>
              <SubLabel>ЩО ЗАВАЖАЛО І ЩО ПОМАГАЛО · {tops.days} ДІБ</SubLabel>
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
              <div className="mt-2 text-[10px] leading-[1.45] text-tx3">
                Скільки діб ти обирав кожен варіант. «Нічого» не рахується — це свідома відповідь,
                а не причина.
              </div>
            </Card>
          )}

          {cat.total >= 5 && (
            <Card>
              <SubLabel>КУДИ ЙДЕ ЧАС · {cat.total} ДІБ</SubLabel>
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
              <div className="mt-2 text-[10px] leading-[1.45] text-tx3">
                «Оцінка» — середня оцінка дня в добах із цією категорією; зʼявляється лише від 4
                оцінених діб.
              </div>
            </Card>
          )}

          {drift.total >= 5 && drift.pct != null && (
            <Card>
              <SubLabel>ПЛАН ПРОТИ РЕАЛЬНОСТІ · {drift.total} ДІБ</SubLabel>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className="font-mono text-[22px] font-medium leading-none"
                  style={{ color: ratingColor(1 + (drift.pct / 100) * 4) }}
                >
                  {drift.pct}%
                </span>
                <span className="text-[11.5px] text-tx2">
                  діб пішли за планом
                  <span className="ml-1 font-mono text-tx3">
                    {drift.matched}/{drift.total}
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
            </Card>
          )}

          {/* Подачі — єдина відповідь, яку застосунок може ПЕРЕВІРИТИ проти
              зовнішнього журналу (appliedLog). Модель такого не вміє: вона
              працює лише всередині самозвіту. Дві колишні окремі картки
              (план подач + звіт↔журнал) зведені в одну — це одна тема. */}
          {(kept.length > 0 || cal.n > 0) && (
            <Card>
              <SubLabel>ПОДАЧІ: СЛОВА ↔ ЖУРНАЛ</SubLabel>
              <div className="mt-2 flex flex-col gap-1.5">
                {kept.length > 0 && (
                  <StatRow
                    label="🎯 Виконав план подач"
                    value={`${keptHit} з ${kept.length} днів`}
                  />
                )}
                {cal.n > 0 && (
                  <StatRow label="📊 Звіт збігся з журналом" value={`${cal.matched} з ${cal.n}`} />
                )}
              </div>
              {(cal.more > 0 || cal.fewer > 0) && (
                <div className="mt-1.5 text-[10px] leading-[1.45] text-tx3">
                  {cal.more > 0 && `${cal.more} дн. подавав поза застосунком`}
                  {cal.more > 0 && cal.fewer > 0 && ' · '}
                  {cal.fewer > 0 && `${cal.fewer} дн. у журналі більше, ніж у звіті`}
                </div>
              )}
            </Card>
          )}

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
