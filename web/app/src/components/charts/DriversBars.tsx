import { scaleLinear } from 'd3-scale';
import type { Stats } from '../../api/schema.ts';
import { fieldLabel, INDEX_COLOR } from '../../lib/checkinIndex.ts';
import { cascade } from '../ui/Cascade.tsx';
import { Hint } from '../ui/primitives.tsx';

// Драйвери «Індексу дня» — Cohen's d (effect size), не гола різниця середніх:
// 0.4 при розкиді 0.3 і при розкиді 2.0 виглядали б однаково без цього.
// Значущість — Welch's t-test (checkin-model.mjs), позначена зіркою при p<0.05.
// Один генеричний рендер замість картки на кожне поле: додав поле в реєстр
// моделі (web/checkin-model.mjs FIELDS) -> воно САМО зʼявляється тут, коли
// набереться вибірка (гейт MIN_N_PER_BUCKET у самій моделі).

const D_SCALE_MAX = 2; // |d|>=2 — «дуже великий» ефект (Cohen), заповнює бар цілком

export function DriversBars({ drivers }: { drivers: Stats['checkinModel']['drivers'] }) {
  if (!drivers.length) return null;
  const top = drivers.slice(0, 6);
  const w = scaleLinear().domain([0, D_SCALE_MAX]).range([0, 100]).clamp(true);

  return (
    <div className="flex flex-col gap-2">
      {top.map((r, i) => {
        const pct = w(Math.abs(r.d));
        const positive = r.d >= 0;
        const color = INDEX_COLOR[r.index] ?? 'var(--color-a2)';
        return (
          <div key={r.field} style={cascade(i, 55)} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-semibold text-tx">{fieldLabel(r.field)}</span>
              {/* ⚠️ Значок тепер за ПОПРАВКОЮ на множинні порівняння, а не за
                  власним p. Драйверів десятки: на 25 полях приблизно один
                  «значущий» результат очікується чисто випадково, тож підпис на
                  найгучнішому рядку був майже гарантований навіть на шумі.
                  Старіший сервер passesBH не віддає — тоді відкочуємось до p,
                  а не ховаємо позначку зовсім. */}
              {(r.passesBH ?? r.p < 0.05) && (
                <span className="font-mono text-[9px] font-semibold" style={{ color }}>
                  {r.passesBH === undefined ? 'значущо' : 'витримує поправку'}
                </span>
              )}
              <span className="ml-auto font-mono text-[10.5px] text-tx3">
                {positive ? '+' : ''}
                {r.delta}
              </span>
            </div>
            <div className="flex h-[7px] items-center overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: `${pct}%`,
                  background: color,
                  opacity: r.p < 0.05 ? 1 : 0.45,
                }}
              />
            </div>
          </div>
        );
      })}
      <Hint>
        Наскільки оцінка дня відрізняється між добами, де показник був високий, і тими, де
        низький. Довжина смуги — СИЛА впливу (не просто різниця середніх), число праворуч — на
        скільки балів зсувається день. «Витримує поправку» означає, що ефект лишається помітним
        навіть з урахуванням того, що показників тут десятки: при такій кількості перевірок
        один-два «відкриття» трапляються чисто випадково, і поправка їх відсіює. Тьмяні смуги —
        даних поки замало, щоб їм вірити.
      </Hint>
    </div>
  );
}
