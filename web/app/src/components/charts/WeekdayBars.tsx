import { useState } from 'react';
import type { HeatmapCell } from '../../api/schema.ts';
import { haptic } from '../../telegram.ts';
import { useInView } from '../../lib/useInView.ts';
import { pluralUk } from '../../lib/plural.ts';

// Агрегація s.heatmap (той самий масив, що Heatmap.tsx) по днях тижня —
// "який день найактивніший" за всю історію збору, а не лише поточний
// тиждень. Нуль бекенд-змін: heatmap[].d уже
// містить дату кожної клітинки, агрегація цілком на фронті.
//
// ⚠️ МЕДІАНА, не середнє (фідбек власника: «чи коректні дані на графіках»).
// Кошик одного дня тижня — це лише 4-5 значень, тож ОДИН аномальний день
// (напр. коли довго щось налаштовував і відкривав апку десятки разів)
// перетягував середнє на себе: стовпчик того дня злітав у стелю, решта
// сплющувалась у Math.max(4,…)-підлогу й ставала візуально нерозрізненною.
// Виходило, що графік стверджував СИСТЕМНІСТЬ («майже завжди той самий
// день»), спираючись рівно на одну випадковість — тобто протилежне тому,
// що обіцяв підпис. Медіана стійка до такого викиду за побудовою.
//
// ui-ux-pro-max (--domain chart): "не лише колір" — акцентний день
// відрізняється й кольором тексту підпису, не тільки кольором стовпчика.

const DOW_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const MAX_H = 46;

// getUTCDay(): 0=Нд..6=Сб -> індекс у DOW_LABELS (0=Пн..6=Нд).
const toMonFirst = (jsDay: number) => (jsDay + 6) % 7;

/** Медіана (порожній кошик -> 0). Той самий метод, що median у stats-core.mjs. */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Квантиль лінійною інтерполяцією — той самий percentile, що в stats-core. */
function q(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo]! : a[lo]! + (a[hi]! - a[lo]!) * (i - lo);
}

export function WeekdayBars({ cells }: { cells: HeatmapCell[] }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [tap, setTap] = useState<number | null>(null);
  if (!cells.length) return null;

  const byDow: number[][] = Array.from({ length: 7 }, () => []);
  const cellsByDow: HeatmapCell[][] = Array.from({ length: 7 }, () => []);
  for (const c of cells) {
    const i = toMonFirst(new Date(`${c.d}T00:00:00Z`).getUTCDay());
    byDow[i]!.push(c.v);
    cellsByDow[i]!.push(c);
  }
  const avgs = byDow.map(median);
  const bestIdx = avgs.indexOf(Math.max(...avgs));
  // ⚠️ РОЗКИД, а не лише медіана. Медіана сама по собі — один біт: «цей день
  // активніший». Вона не каже головного: чи різниця СТАБІЛЬНА, чи це два
  // випадкові тижні. Вус q1..q3 відповідає на це прямо в стовпчику, без тапу.
  const spreads = byDow.map((xs) => ({ q1: q(xs, 0.25), q3: q(xs, 0.75), n: xs.length }));
  // ⚠️ ШКАЛА ВРАХОВУЄ ВУСА, а не лише медіани. Перша версія брала max самих
  // медіан — і вус, чий q3 більший за найбільшу медіану (а це норма: медіана
  // стійка до сплесків, q3 — ні), вилазив ВИЩЕ поля графіка. Наживо це
  // виглядало як білі палиці поверх заголовка сусідньої секції.
  const max = Math.max(1, ...avgs, ...spreads.map((s) => s.q3));
  /** Значення -> висота в пікселях, зрізана полем. */
  const yOf = (v: number) => Math.max(0, Math.min(MAX_H, (v / max) * MAX_H));
  const sel = tap !== null ? cellsByDow[tap]! : null;

  return (
    // ⚠️ Власного заголовка більше НЕМАЄ: блок переїхав із підвалу теплокарти
    // у свою картку, і підписує його тепер SubLabel, як усі інші. Два різні
    // способи називати картку на одному екрані — це той дрібний розсинхрон,
    // з якого починається «чому тут інакше».
    <div ref={ref} className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2 pt-1">
        {DOW_LABELS.map((label, i) => {
          const v = avgs[i];
          const h = v > 0 ? Math.max(4, Math.round(yOf(v))) : 3;
          const isBest = i === bestIdx && v > 0;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={tap === i}
              aria-label={`${label}: типово ${v} ${pluralUk(Math.round(v), ['дія', 'дії', 'дій'])}, середня половина ${Math.round(spreads[i]!.q1)}–${Math.round(spreads[i]!.q3)}, ${spreads[i]!.n} ${pluralUk(spreads[i]!.n, ['такий день', 'такі дні', 'таких днів'])}`}
              onClick={() => {
                haptic('light');
                setTap(tap === i ? null : i);
              }}
              className="flex flex-1 flex-col items-center gap-[5px]"
            >
              {/* ⚠️ Поле ФІКСОВАНОЇ висоти, стовпчик притиснутий до низу.
                  Доти контейнер мав висоту САМОГО СТОВПЧИКА, а вус позиціювався
                  всередині нього — тобто будь-яке значення вище за медіану
                  виходило за контейнер, і нічого його не стримувало. */}
              <div className="relative w-full overflow-hidden" style={{ height: MAX_H }}>
                <div
                  className="absolute inset-x-0 bottom-0"
                  style={{
                    height: h,
                    borderRadius: '6px 6px 3px 3px',
                    background: isBest
                      ? 'linear-gradient(180deg,var(--color-a2),var(--color-a1))'
                      : v > 0
                        ? 'var(--color-tx3)'
                        : 'var(--color-track)',
                    opacity: isBest ? 1 : tap === i ? 0.85 : 0.55,
                    animation: `barGrow .5s cubic-bezier(.22,1,.36,1) ${i * 45}ms backwards`,
                    animationPlayState: inView ? 'running' : 'paused',
                  }}
                />
                {/* Вус q1..q3 у ТІЙ САМІЙ шкалі, що висота: піксель на одиницю
                    дій. Інакше два канали малювали б різні величини одним
                    розміром — рівно та помилка, яку в цій ревізії й ловимо. */}
                {spreads[i]!.n > 1 && (
                  <div
                    className="absolute left-1/2 w-[2px] -translate-x-1/2 rounded-full"
                    style={{
                      bottom: Math.round(yOf(spreads[i]!.q1)),
                      height: Math.max(1, Math.round(yOf(spreads[i]!.q3) - yOf(spreads[i]!.q1))),
                      background: 'var(--color-tx)',
                      opacity: 0.45,
                    }}
                  />
                )}
              </div>
              <span
                className="font-mono text-[9px] font-medium"
                style={{ color: isBest ? 'var(--color-a2)' : 'var(--color-tx3)' }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
      {sel && tap !== null && (
        <div className="flex flex-col gap-0.5 rounded-xl border border-glassb bg-glass px-2.5 py-2 text-[10.5px] text-tx2">
          <div className="flex items-baseline">
            <span className="font-semibold">{DOW_LABELS[tap]}</span>
            <span className="ml-auto font-mono text-[9.5px] text-tx3">
              {sel.length} {pluralUk(sel.length, ['такий день', 'такі дні', 'таких днів'])}
            </span>
          </div>
          <div className="font-mono text-[9.5px] text-tx3">
            типово {avgs[tap]} {pluralUk(Math.round(avgs[tap]!), ['дія', 'дії', 'дій'])} · середня
            половина {Math.round(spreads[tap]!.q1)}–{Math.round(spreads[tap]!.q3)} · найактивніший{' '}
            {Math.max(...sel.map((c) => c.v))}
          </div>
          <div className="flex flex-wrap gap-x-2.5 font-mono text-[9.5px] text-tx3">
            <span>відкриттів {sel.reduce((a, c) => a + c.o, 0)}</span>
            <span>питань {sel.reduce((a, c) => a + c.m, 0)}</span>
            <span>новин {sel.reduce((a, c) => a + c.n, 0)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
