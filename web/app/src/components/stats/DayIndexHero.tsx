import type { Stats } from '../../api/schema.ts';
import { useCountUp } from '../ui/CountUp.tsx';
import { useInView } from '../../lib/useInView.ts';
import { INDEX_COLOR, INDEX_LABEL, INDEX_ORDER } from '../../lib/checkinIndex.ts';
import { Hint } from '../ui/primitives.tsx';

// «Індекс дня» (0–100) — не наша оцінка, а ridge-регресія (checkin-model.mjs)
// на ВЛАСНИХ dayScore людини: ваги нижче кажуть, з чого САМЕ в неї складається
// хороший день, а не з чого «мусить» складатись хороший день узагалі.
//
// Той самий hero-стиль градієнтного числа, що вже в Надійності/Активності
// (--grad, font-mono, tracking) — візуальна консистентність між усіма
// «великими числами» екрана.

function scoreColor(v: number): string {
  const t = Math.max(0, Math.min(1, v / 100));
  return `hsl(${Math.round(t * 125)}, 62%, 58%)`;
}

export function DayIndexHero({ model }: { model: Stats['checkinModel'] }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const last = model.dayIndex.last;
  const shown = useCountUp(last ?? 0, inView);

  if (last === null) return null;

  const weights = INDEX_ORDER.map((idx) => ({
    idx,
    weight: model.fit.weights[idx] ?? 0.2,
  })).sort((a, b) => b.weight - a.weight);

  return (
    <div className="flex flex-col gap-3">
      <div ref={ref} className="flex items-baseline gap-2">
        <span
          className="font-mono text-[34px] font-medium leading-none tracking-[-0.02em]"
          style={{ color: scoreColor(last) }}
        >
          {shown}
        </span>
        <span className="text-[11.5px] font-medium text-tx2">
          Індекс дня
          {model.dayIndex.mean !== null && (
            <span className="ml-1 font-mono text-tx3">(середній {model.dayIndex.mean})</span>
          )}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {weights.map(({ idx, weight }) => (
          <div key={idx} className="flex items-center gap-2">
            <span className="w-[84px] flex-none text-[11px] font-medium text-tx2">
              {INDEX_LABEL[idx]}
            </span>
            <div className="flex h-[6px] flex-1 items-center overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.round(weight * 100)}%`, background: INDEX_COLOR[idx] }}
              />
            </div>
            <span className="w-[32px] flex-none text-right font-mono text-[10.5px] text-tx3">
              {Math.round(weight * 100)}%
            </span>
          </div>
        ))}
      </div>

      <Hint>
        Одне число 0–100 замість десятка окремих: усі відповіді чек-іну зведені в пʼять
        напрямів, а смуги показують, скільки кожен важить.{' '}
        {model.fit.learned
          ? `Ваги не задані наперед — модель вивела їх із твоїх ${model.fit.n} діб, звіряючись із тим, як ти сам оцінював день. Тобто це твоє означення хорошого дня, не чуже. R²=${model.fit.r2?.toFixed(2)} — наскільки добре пʼять напрямів пояснюють твої оцінки (1.0 = ідеально).`
          : `Поки ваги однакові: щоб вивести саме твої, треба 20+ заповнених діб, зараз ${model.fit.n}.`}
      </Hint>
    </div>
  );
}
