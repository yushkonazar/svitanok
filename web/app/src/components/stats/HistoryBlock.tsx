import { useState } from 'react';
import { useArchive } from '../../api/hooks.ts';
import { haptic } from '../../telegram.ts';
import { SectionHead, Hint } from '../ui/primitives.tsx';
import { MiniTrend } from '../charts/MiniTrend.tsx';

// F · Історія — єдине місце на екрані, що дивиться далі за квартал.
//
// ⚠️ ЩО ЦЕЙ БЛОК МОЖЕ, А ЧОГО НІ. Він читає холодний архів (statsArchive),
// куди крон раз на добу кладе МІСЯЧНІ СЕРЕДНІ. Це свідомо вузький набір: архів
// має пережити роки, тож кожне зайве поле — те, що потім не прибрати без
// втрати сумісності з уже записаним.
//
// Наслідок, який варто знати: карту станів сюди розширити НЕ МОЖНА. Вона
// показує розподіл 5×5 «енергія×настрій», а архів такого не зберігає — лише
// середні. Тому «рік/усе» зʼявляється тут окремим блоком, а не ще одним
// пунктом у перемикачі періоду карти: інакше перемикач обіцяв би те, чого
// даних під ним немає.
//
// ⚠️ Вантажиться ЛИШЕ на розгортанні: це додаткове читання KV, і вішати його
// на кожне відкриття дашборда заради даних, які дивляться раз на місяць, —
// марна ціна. Той самий мотив, що тримає архів окремо від /api/stats.

/** Менше двох місяців — це не історія, а один рядок. */
const MIN_MONTHS = 2;

/**
 * Нижче цього — ТАБЛИЦЯ, не лінія.
 *
 * ⚠️ Лінія з двох-трьох точок — гірша форма за числа, і не через естетику.
 * Відрізок між двома точками виглядає як ТРЕНД, хоч двома точками тренду не
 * буває: нахил там повністю визначений двома значеннями й міняється вдвічі
 * від одного місяця. Числа рядком кажуть рівно те, що відомо, і не вдають
 * напрямку, якого ще немає.
 */
const MIN_MONTHS_FOR_LINE = 4;

const MONTHS = [
  'січ',
  'лют',
  'бер',
  'кві',
  'тра',
  'чер',
  'лип',
  'сер',
  'вер',
  'жов',
  'лис',
  'гру',
];

/** '2026-07' -> 'лип 26'. Рік потрібен: блок і живе заради переходу через роки. */
function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  const idx = Number(m) - 1;
  return `${MONTHS[idx] ?? m} ${String(y).slice(2)}`;
}

type Row = { key: string; label: string; series: (number | null)[]; hint: string };

export function HistoryBlock() {
  const [open, setOpen] = useState(false);
  const { data: months, isLoading, isError } = useArchive(open);

  const enough = (months?.length ?? 0) >= MIN_MONTHS;
  const weeks = (months ?? []).map((m) => monthLabel(m.month));

  const rows: Row[] = months
    ? [
        {
          key: 'dayScore',
          label: 'ОЦІНКА ДНЯ',
          series: months.map((m) => m.dayScoreAvg),
          hint: 'Середня власна оцінка дня за місяць, шкала 1–5.',
        },
        {
          key: 'sleep',
          label: 'СОН',
          series: months.map((m) => m.sleepAvg),
          hint: 'Середня тривалість сну за місяць, години.',
        },
        {
          key: 'active',
          label: 'АКТИВНІ ДОБИ',
          series: months.map((m) => m.activeDays),
          hint: 'Скільки діб місяця мали бодай якусь дію в застосунку.',
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Історія</SectionHead>

      <button
        type="button"
        onClick={() => {
          haptic('light');
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1.5 self-start rounded-full border border-glassb bg-glass px-3 py-1.5 text-[11px] font-semibold text-tx2"
      >
        <span>{open ? '− Згорнути' : '+ Показати по місяцях'}</span>
      </button>

      {open && isLoading && <div className="text-[11px] text-tx3">Завантажую…</div>}

      {open && isError && (
        <div className="text-[11px] leading-[1.5] text-tx3">
          Не вдалося прочитати історію. Це окреме сховище — решта статистики від цього не
          залежить.
        </div>
      )}

      {open && !isLoading && !isError && !enough && (
        <div className="text-[11px] leading-[1.5] text-tx3">
          Історія збирається помісячно й починається з першої повної згортки. Зараз місяців{' '}
          {months?.length ?? 0} — блок зʼявиться, коли їх стане щонайменше {MIN_MONTHS}.
        </div>
      )}

      {open && enough && (
        <div className="flex flex-col gap-3.5">
          {rows.map((r) => (
            <div key={r.key} className="rounded-2xl border border-glassb bg-glass p-3.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
                  {r.label} · {months!.length} МІС.
                </span>
              </div>
              {months!.length >= MIN_MONTHS_FOR_LINE ? (
                <>
                  <div className="mt-2">
                    <MiniTrend weeks={[]} series={r.series} />
                  </div>
                  {/* ⚠️ Підписи осі — свої, а не з MiniTrend. Той форматує
                      ISO-дати («10.08»), і на місячному ряді це читалось би як
                      ЧИСЛО, а не як місяць: «01.07» виглядає першим липня, хоч
                      означає весь липень. Порожній `weeks` вимикає його
                      підписи, а перший і останній місяць пишемо самі — 14
                      підписів у ряд однаково не влізли б на 375px. */}
                  <div className="mt-1 flex justify-between font-mono text-[9px] text-tx3">
                    <span>{weeks[0]}</span>
                    <span>{weeks[weeks.length - 1]}</span>
                  </div>
                </>
              ) : (
                // Числа рядком: двома точками тренду не буває, а відрізок між
                // ними виглядає саме як тренд.
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {months!.map((m, i) => (
                    <span key={m.month} className="font-mono text-[10.5px] text-tx2">
                      <span className="text-tx3">{weeks[i]} </span>
                      {r.series[i] === null ? '—' : r.series[i]}
                    </span>
                  ))}
                </div>
              )}
              <Hint>{r.hint}</Hint>
            </div>
          ))}
          <Hint>
            {months!.length < MIN_MONTHS_FOR_LINE
              ? 'Поки місяців менше за ' + MIN_MONTHS_FOR_LINE + ', показані числа, а не лінія: двома-трьома точками тренду не буває, а відрізок між ними виглядав би саме як тренд. '
              : ''}
            Місячні середні з окремого холодного сховища — саме тому цей блок бачить далі за
            решту екрана, яка живе на 30–90 добах. Порожній місяць дає розрив у лінії, а не
            падіння в нуль. Уже записаний місяць більше не перераховується: його сирі доби
            з часом виходять за межі зберігання, і перерахунок дав би гірше число, ніж те,
            що збережено.
          </Hint>
        </div>
      )}
    </div>
  );
}
