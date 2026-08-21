import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { pluralUk } from '../../lib/plural.ts';
import { weeksWindowLabel } from '../../lib/windowLabel.ts';
import { masteryRows, remaining, weeksLeft, MIN_SEEN, type MasteryRow } from '../../lib/mastery.ts';
import { haptic } from '../../telegram.ts';
import { SectionHead, StatRow, Ph, Hint } from '../ui/primitives.tsx';
import { MiniTrend } from '../charts/MiniTrend.tsx';

// C · Майстерність — ПОВНИЙ редизайн. Блок був вимкнений із рендера 29.07 із
// вердиктом власника «абсолютно не розумію, що мені показується».
//
// Чому не розумів: три незалежні сутності (роадмеп, mock-питання, тема тижня)
// стояли поруч без жодного звʼязку, і жодне число не відповідало на питання, з
// яким сюди приходять. Решта секцій статистики вже мали таке питання («Індекс
// дня» для чек-іну, «чи це ритуал» для звичок) — тут його не було.
//
// Питання цього блоку: ЩО Я ЗНАЮ, А ЩО НІ.
//
// Відповідь дає зіставлення, якого доти не існувало на екрані: прогрес роадмепу
// (що я відмітив пройденим) × статистика mock-питань (як воно насправді
// даються). Обидва боки й раніше були в payload, але порізно — таблиця звʼязку
// mock↔roadmap живе на сервері, тож зшити їх міг лише він.
//
// ⚠️ ЧОМУ БАРИ, А НЕ КВАДРАНТ. Перша ідея була скатером «пройдено × дається» —
// два виміри, чотири квадранти, красиво. База чартів (ui-ux-pro-max,
// --domain chart) її прямо відхилила: скатер протипоказаний при «fewer than 20
// points» і в «mobile-primary context», а тут 13 тем на 375px. Натомість
// горизонтальні бари мають оцінку доступності AAA при «categories ≤ 15» і
// вимогу «always sort descending». Тож інсайт подає ПОРЯДОК рядків, а не
// положення точки: найбільший розрив угорі.

/** Скільки рядків показуємо згорнутими — далі йде хвіст, який ніхто не читає. */
const PREVIEW_ROWS = 5;

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">{children}</div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-glassb bg-glass p-4">{children}</div>;
}

/**
 * Рядок теми: дві смуги на спільній шкалі 0-100.
 *
 * Значення підписані числом на кожній смузі (вимога БД чартів: «value labels on
 * each bar by default») — і це ж закриває «color only»: смуги розрізняються не
 * лише кольором, а підписом і порядком.
 */
function TopicRow({ row }: { row: MasteryRow }) {
  const bar = (v: number, color: string, label: string) => (
    <div className="flex items-center gap-1.5">
      <span className="w-[54px] flex-none font-mono text-[9px] text-tx3">{label}</span>
      <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-track">
        <div className="h-full rounded-full" style={{ width: `${v}%`, background: color }} />
      </div>
      <span className="w-[30px] flex-none text-right font-mono text-[10px] font-semibold text-tx2">
        {v}%
      </span>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{row.title}</span>
        {row.gap >= 15 && (
          <span className="flex-none font-mono text-[9.5px] font-semibold text-neg">
            розрив {row.gap}
          </span>
        )}
      </div>
      {bar(row.donePct, 'var(--color-a2)', 'відмічено')}
      {bar(row.easePct, 'var(--color-pos)', 'дається')}
      <span className="font-mono text-[9px] text-tx3">
        {row.done}/{row.total} підпунктів · {row.seen}{' '}
        {pluralUk(row.seen, ['питання', 'питання', 'питань'])}
      </span>
    </div>
  );
}

/**
 * Майстерність, згорнута за замовчуванням і в самому кінці екрана.
 *
 * ⚠️ Це вимога власника, і вона збігається з тим, що видно з даних: поки по
 * темі не набралось {MIN_SEEN} питань, вона падає в «ще не перевірено», а
 * картки «Розрив», «Темп» і «Чи стає легше» ховаються власними гейтами. Тобто
 * розгорнутий блок довго показує майже порожнечу — це аргумент ЗА згортання,
 * не проти.
 *
 * Лінивого завантаження тут НЕМАЄ й не треба, на відміну від «Історії»: усе
 * вже приїхало в /api/stats. Згортання економить УВАГУ, не трафік.
 */
export function MasteryBlock({ s }: { s: Stats }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Майстерність</SectionHead>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1.5 self-start rounded-full border border-glassb bg-glass px-3 py-1.5 text-[11px] font-semibold text-tx2"
      >
        <span>{open ? '− Згорнути' : '+ Відкрити'}</span>
      </button>
      {open && <MasteryBody s={s} />}
    </div>
  );
}

/** Тіло блоку. Експортується заради тестів: логіка рядків не залежить від того,
 *  розгорнута оболонка чи ні, тож перевіряти її крізь клік — зайвий крок. */
export function MasteryBody({ s }: { s: Stats }) {
  const [expanded, setExpanded] = useState(false);
  const topics = s.mastery?.topics ?? [];
  const { rated, unrated } = masteryRows(topics);
  const left = remaining(topics);
  const eta = weeksLeft(s.roadmapWeekly, left);
  const tw = s.mastery?.themeOfWeek;
  const roadmapGrowth = s.roadmapWeekly.some((w) => w.count > 0);
  // Два тижні з даними — мінімум, за якого лінія взагалі щось означає.
  const easeWeeks = s.mock.easeTrend.filter((w) => w.easePct !== null);

  if (!topics.length) {
    return (
      <Ph>Позначай пройдене в /roadmap і відповідай на питання дня — тут зʼявиться картина</Ph>
    );
  }

  const shown = expanded ? rated : rated.slice(0, PREVIEW_ROWS);

  return (
    <div className="flex flex-col gap-3.5">
      {/* 1. РОЗРИВ — головне питання блоку: де відмічене розходиться зі знанням. */}
      {rated.length > 0 && (
        <Card>
          <SubLabel>ВІДМІЧЕНО ПРОТИ «ДАЄТЬСЯ»</SubLabel>
          <div className="mt-3 flex flex-col gap-3.5">
            {shown.map((r) => (
              <TopicRow key={r.id} row={r} />
            ))}
          </div>
          {rated.length > PREVIEW_ROWS && (
            <button
              type="button"
              onClick={() => {
                haptic('light');
                setExpanded((v) => !v);
              }}
              className="mt-3 self-start rounded-full border border-glassb bg-glass px-3 py-1 text-[10.5px] font-semibold text-tx2"
            >
              {expanded ? '− Згорнути' : `+ Ще ${rated.length - PREVIEW_ROWS}`}
            </button>
          )}
          <Hint>
            Верхня смуга — скільки підпунктів теми ти відмітив пройденими, нижня — скільки питань по
            ній НЕ виявились складними. Теми впорядковані за розривом: угорі ті, де відмічено
            багато, а даються погано. Це найкорисніший сигнал тут — решта показує лише один бік.
          </Hint>
        </Card>
      )}

      {/* 2. НЕ ПЕРЕВІРЕНО — чесний гейт замість нуля в рейтингу. */}
      {unrated.length > 0 && (
        <Card>
          <SubLabel>ЩЕ НЕ ПЕРЕВІРЕНО · {unrated.length}</SubLabel>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {unrated.map((t) => (
              <span
                key={t.id}
                className="rounded-full border border-glassb px-2 py-1 text-[10.5px] text-tx2"
              >
                {t.title}
                <span className="ml-1 font-mono text-[9px] text-tx3">
                  {t.done}/{t.total}
                </span>
              </span>
            ))}
          </div>
          <Hint>
            Теми, по яких питань ще не було (або менше {MIN_SEEN}). Вони НЕ показані як «0% —
            погано»: це різні речі — не даються й не питали. Поки їх не перевірено, про них нічого
            не відомо, скільки б підпунктів не було відмічено.
          </Hint>
        </Card>
      )}

      {/* 3. ТЕМП — скільки лишилось і за скільки, якщо темп збережеться. */}
      {roadmapGrowth && (
        <Card>
          <SubLabel>ТЕМП · {weeksWindowLabel(s.roadmapWeekly.length)}</SubLabel>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-mono text-[22px] font-medium leading-none">{left}</span>
            <span className="text-[11.5px] text-tx2">
              {pluralUk(left, ['підпункт лишився', 'підпункти лишились', 'підпунктів лишилось'])}
              {eta !== null && (
                <span className="ml-1 font-mono text-tx3">
                  ~{eta} {pluralUk(eta, ['тиждень', 'тижні', 'тижнів'])} за поточним темпом
                </span>
              )}
            </span>
          </div>
          <div className="mt-2">
            <MiniTrend
              weeks={s.roadmapWeekly.map((w) => w.week)}
              series={s.roadmapWeekly.map((w) => w.count)}
            />
          </div>
          <Hint>
            Скільки підпунктів роадмепу ти закривав щотижня. Прогноз рахується за темпом ОСТАННІХ
            чотирьох тижнів, а не за всією історією — давній ривок не має обіцяти те, чого зараз
            немає. Без темпу прогноз не показується взагалі.
          </Hint>
        </Card>
      )}

      {/* 3.5 ЧИ СТАЄ ЛЕГШЕ — єдиний тут погляд у ЧАС, а не в поточний стан.
          Довго був неможливий: оцінки лежали без таймстемпа, і хронологію
          довелось би виводити з порядку ключів обʼєкта — тобто з того, що JS
          не гарантує. Тепер час є, і питання «я просто відмічаю пройдене чи
          справді починаю це знати» нарешті має відповідь. */}
      {easeWeeks.length >= 2 && (
        <Card>
          <SubLabel>ЧИ СТАЄ ЛЕГШЕ · ЗА {s.mock.easeTrend.length} ТИЖНІВ</SubLabel>
          <div className="mt-2">
            <MiniTrend
              weeks={s.mock.easeTrend.map((w) => w.week)}
              series={s.mock.easeTrend.map((w) => w.easePct)}
            />
          </div>
          <Hint>
            Частка питань, які ти позначив легкими, по тижнях. Тиждень без питань — розрив у лінії,
            а не падіння в нуль: «не питали» і «все було складно» — різні відповіді. Лінія вгору
            означає, що матеріал справді осідає, а не лише відмічається пройденим.
          </Hint>
        </Card>
      )}

      {/* 4. ФОКУС — рекомендація на тиждень; наслідок картини вище, тому внизу. */}
      {tw && (
        <div className="flex flex-col gap-0.5">
          <SubLabel>ФОКУС НА ЦЕЙ ТИЖДЕНЬ</SubLabel>
          <div className="flex items-center">
            <span className="text-[12.5px] font-bold">{tw.title}</span>
            <span className="ml-auto font-mono text-[11px] font-medium text-tx2">
              {tw.done}/{tw.total}
            </span>
          </div>
        </div>
      )}

      {has(s.mock.streak) && s.mock.streak > 0 && (
        <StatRow label="Стрік питань дня" value={`🔥 ${s.mock.streak} дн.`} />
      )}
    </div>
  );
}
