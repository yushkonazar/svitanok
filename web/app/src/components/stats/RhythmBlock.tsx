import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { haptic } from '../../telegram.ts';
import { clamp, has } from '../../lib/format.ts';
import { useInView } from '../../lib/useInView.ts';
import { SectionHead, StatRow, Hint } from '../ui/primitives.tsx';
import { pluralUk } from '../../lib/plural.ts';
import { MiniTrend } from '../charts/MiniTrend.tsx';
// ⚠️ Глибина береться з s.windows, а НЕ з рядка. Доти тут стояло зашите
// «8 ТИЖНІВ» окремо від серверної константи: змінилась би вона — підпис
// збрехав би мовчки, і дізнатись про це не було б звідки.
import { weeksWindowLabel } from '../../lib/windowLabel.ts';

// Ритм (повний редизайн статистики, замінює колишню «Воронка та ціль») —
// картки-лічильники стадій (saved/applied/interview/offer) прибрано ЦІЛКОМ:
// вони буквально дублювали jobs/FunnelWidget.tsx на вкладці «Вакансії» (той
// самий s.funnel, той самий вигляд). Лишається лише унікальний контент,
// якого там немає: конверсії з дійшов-до-стадії (F1, чесний знаменник),
// закриті, тижнева ціль-смуга — і два тренди (fit%/подачі по тижнях) замість
// голого числа/базового спарклайна, щоб "чи я на правильному шляху" читалось
// з форми лінії, а не лише з одного відсотка.

/** Підпис кроку — «куди дійшли», бо саме це очікування й міряється. */
const STEP_LABEL: Record<string, string> = {
  applied: 'Збережено → подано',
  interview: 'Подано → співбесіда',
  offer: 'Співбесіда → офер',
};

const STAGE_SHORT: Record<string, string> = {
  saved: 'збережено',
  applied: 'подано',
  interview: 'співбесіда',
};

/**
 * Крок конверсії — з ЯВНИМ станом «знаменник порожній».
 *
 * ⚠️ Доти рядок показував «0%» і при нулі співбесід, і при нулі оферів із
 * десяти співбесід: хвостик «x/y» ховався разом із знаменником, а сам нуль
 * лишався. Тобто ВІДСУТНІСТЬ ДАНИХ виглядала точно як ПОГАНИЙ РЕЗУЛЬТАТ —
 * найгірший різновид нуля, і рівно та помилка, яку в Майстерності вже
 * виправили через easePct = null («не питали» ≠ «все складно»).
 *
 * Тепер порожній знаменник каже про себе словами, а відсоток не малюється.
 */
function ConversionRow({
  label,
  pct,
  num,
  den,
  jobs,
}: {
  label: string;
  pct: number | null | undefined;
  num: number;
  den: number;
  /** Вакансії, що ЗАРАЗ стоять на цільовій стадії — розкриваються тапом. */
  jobs?: Stats['funnelList'];
}) {
  const [open, setOpen] = useState(false);
  if (den <= 0) {
    return (
      <StatRow label={label} value={<span className="font-normal text-tx3">ще не було</span>} />
    );
  }
  if (!has(pct)) return null;
  const row = (
    <StatRow
      label={label}
      value={
        <>
          {pct}%
          <span className="ml-1.5 font-normal text-tx3">
            {num}/{den}
          </span>
        </>
      }
    />
  );
  // ⚠️ Відсоток без імен — це число, з якого нічого не зробиш. Тап показує
  // КОНКРЕТНІ вакансії на цільовій стадії, тобто перетворює звіт на список.
  // Дані вже на клієнті (funnelList), тобто бракувало не інформації, а місця.
  if (!jobs || jobs.length === 0) return row;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((v) => !v);
        }}
        className="text-left"
      >
        {row}
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 rounded-xl border border-glassb bg-glass px-2.5 py-1.5">
          {jobs.slice(0, 5).map((j) => (
            <span key={j.url} className="truncate text-[10.5px] text-tx2">
              {j.title || j.url}
            </span>
          ))}
          {jobs.length > 5 && (
            <span className="font-mono text-[9.5px] text-tx3">…ще {jobs.length - 5}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Ритм, згорнутий і в хвості екрана — на вимогу власника.
 *
 * ⚠️ Збігається з тим, що видно з даних. Блок відповідає на питання пошуку
 * роботи, а воронка рухається ТИЖНЯМИ: конверсії, медіани кроків і «лежить без
 * руху» не змінюються від того, що ти відкрив застосунок удруге за день.
 * Розгорнутий він щодня займав три картки, щоб повідомити те саме, що вчора.
 *
 * Найдієвіше з нього («лежить без руху 21+ діб») від згортання не втрачається:
 * саме цей рядок уже щодня приходить у /stats бота, тобто в місце, яке
 * пробігають очима, а не гортають.
 */
export function RhythmBlock({ s }: { s: Stats }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Ритм</SectionHead>
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
      {open && <RhythmBody s={s} />}
    </div>
  );
}

/** Тіло блоку. Експортується заради тестів — та сама причина, що в
 *  MasteryBody: логіка рядків не залежить від стану оболонки. */
export function RhythmBody({ s }: { s: Stats }) {
  const speed = s.funnelSpeed;
  // Смуга цілі заповнюється, коли доїхала до екрана — той самий barFill, що
  // й смуги навичок у MasteryBlock.
  const [goalRef, goalInView] = useInView<HTMLDivElement>();
  const goalPct = has(s.goal.weeklyTarget)
    ? clamp(
        Math.round(((s.goal.weeklyApplied || 0) / Math.max(1, s.goal.weeklyTarget!)) * 100),
        0,
        100,
      )
    : 0;
  const appliedSum = s.appliedWeekly.reduce((a, w) => a + (w.count || 0), 0);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-[9px]">
        {/* Конверсії з «дійшов до» (F1): знаменник — усі, хто КОЛИСЬ був на
            стадії, тож відмова його не зменшує. */}
        <ConversionRow
          label="Подав → співбесіда"
          pct={s.conversion.appliedToInterview}
          num={s.reached.interview}
          den={s.reached.applied}
          jobs={s.funnelList.filter((j) => j.stage === 'interview')}
        />
        <ConversionRow
          label="Співбесіда → офер"
          pct={s.conversion.interviewToOffer}
          num={s.reached.offer}
          den={s.reached.interview}
          jobs={s.funnelList.filter((j) => j.stage === 'offer')}
        />
        {(s.funnel.rejected > 0 || s.funnel.failed > 0) && (
          <StatRow
            label="Закрито (відмова / провал)"
            value={`${s.funnel.rejected} / ${s.funnel.failed}`}
          />
        )}
        {has(s.goal.weeklyTarget) && (
          <>
            <StatRow
              label="Тижневі відгуки (ціль)"
              value={`${s.goal.weeklyApplied || 0} / ${s.goal.weeklyTarget}`}
            />
            <div ref={goalRef} className="h-2 overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${goalPct}%`,
                  background: 'linear-gradient(90deg,var(--color-a1),var(--color-a2))',
                  animation: 'barFill .8s cubic-bezier(.22,1,.36,1) backwards',
                  animationPlayState: goalInView ? 'running' : 'paused',
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* ШВИДКІСТЬ. Доти блок відповідав лише на «скільки»: відсотки конверсій,
          ціль, два тренди. «А скільки це триває» і «що лежить без руху» не мало
          відповіді ніде — при тому, що журнал переходів (funnelMeta.history)
          збирається давно й уже їде в payload заради «Історії» у шторці.
          Для того, хто шукає роботу, це найпрактичніше тут: «подав 12 діб тому
          й тиша» — привід написати, а не чекати далі. */}
      {speed.steps.some((st) => st.n > 0) && (
        <div className="flex flex-col gap-2 rounded-2xl border border-glassb bg-glass p-4">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            СКІЛЬКИ ТРИВАЄ КРОК
          </span>
          {speed.steps.map((st) => (
            <div key={st.to} className="flex items-baseline gap-2 text-[11.5px]">
              <span className="flex-1 text-tx2">{STEP_LABEL[st.to] ?? st.to}</span>
              {st.medianDays !== null ? (
                <span className="font-mono text-[11px] font-semibold">
                  {st.medianDays} {pluralUk(st.medianDays, ['доба', 'доби', 'діб'])}
                </span>
              ) : (
                // ⚠️ НЕ нуль і не прочерк без пояснення: «замало» — це інша
                // відповідь, ніж «миттєво», і плутати їх тут найлегше.
                <span className="font-mono text-[10px] text-tx3">замало переходів</span>
              )}
              <span className="w-[52px] flex-none text-right font-mono text-[10px] text-tx3">
                {st.n} {pluralUk(st.n, ['перехід', 'переходи', 'переходів'])}
              </span>
            </div>
          ))}
          <Hint>
            Медіана, а не середнє: одна вакансія, що пролежала пів року, інакше зсунула б усю
            оцінку. «Замало переходів» означає, що крок проходили менше трьох разів — на такій
            вибірці будь-яке число було б вигадкою.
          </Hint>
        </div>
      )}

      {speed.stale.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-glassb bg-glass p-4">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            ЛЕЖИТЬ БЕЗ РУХУ · {speed.staleAfterDays}+ ДІБ
          </span>
          {speed.stale.slice(0, 5).map((j) => (
            <div key={j.url} className="flex items-baseline gap-2 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-tx2">{j.title || j.url}</span>
              <span className="flex-none font-mono text-[10px] text-tx3">
                {STAGE_SHORT[j.stage] ?? j.stage}
              </span>
              <span className="w-[46px] flex-none text-right font-mono text-[10.5px] font-semibold text-neg">
                {j.days} дн.
              </span>
            </div>
          ))}
          {speed.stale.length > 5 && (
            <span className="font-mono text-[10px] text-tx3">…і ще {speed.stale.length - 5}</span>
          )}
          <Hint>
            Скільки діб вакансія стоїть на тій самій стадії. Рахується від ОСТАННЬОГО руху, а не від
            дати збереження: вакансія може бути у воронці пів року, але якщо стадію змінили вчора —
            це рух. Термінальні (відмова/провал/офер) сюди не потрапляють: там уже нічого не
            чекають.
          </Hint>
        </div>
      )}

      {has(s.avgFitApplied) && (
        <div>
          <div className="mb-1 flex items-baseline gap-1.5">
            <span className="font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
              FIT% ПОДАНИХ · {weeksWindowLabel(s.windows.trendWeeks)}
            </span>
            <span className="font-mono text-[11px] font-semibold text-tx2">
              {s.avgFitApplied}% зараз
            </span>
          </div>
          <MiniTrend
            weeks={s.fitWeekly.map((w) => w.week)}
            series={s.fitWeekly.map((w) => w.avgFit)}
          />
        </div>
      )}

      {appliedSum > 0 && (
        <div>
          <div className="mb-1 font-mono text-[9.5px] font-semibold tracking-[0.1em] text-tx3">
            ПОДАЧІ · {weeksWindowLabel(s.windows.trendWeeks)} (РАЗОМ {appliedSum})
          </div>
          <MiniTrend
            weeks={s.appliedWeekly.map((w) => w.week)}
            series={s.appliedWeekly.map((w) => w.count)}
          />
        </div>
      )}
    </div>
  );
}
