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

/**
 * Пояснення якості підгонки.
 *
 * ⚠️ Показуємо КРОС-ВАЛІДОВАНИЙ R², а не внутрішньовибірковий. Другий міряє,
 * наскільки добре модель описала ті самі доби, на яких училась, — він завжди
 * оптимістичний і зростає від самого додавання предикторів. Перший міряє
 * передбачення НЕ баченої доби, тобто те, заради чого модель і потрібна.
 *
 * Відʼємний CV-R² не ховаємо: це означає «гірше за просте середнє», і саме тоді
 * числу вірити не варто. Мовчання тут було б найгіршим варіантом.
 */
function cvNote(fit: Stats['checkinModel']['fit']): string {
  const cv = fit.r2cv;
  if (cv === null || cv === undefined) return '';
  if (cv <= 0) {
    return 'Але передбачати нову добу вона поки не вміє: на перевірці з відкладеною добою модель програє простому середньому. Числам вище варто вірити як опису, не як прогнозу.';
  }
  return `R²=${cv.toFixed(2)} на перевірці з відкладеною добою — наскільки пʼять напрямів пояснюють оцінку доби, якої модель не бачила (1.0 = ідеально).`;
}

export function DayIndexHero({ model }: { model: Stats['checkinModel'] }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const last = model.dayIndex.last;
  const shown = useCountUp(last ?? 0, inView);

  // ⚠️ ГЕЙТ ПОКРИТТЯ. Доти доба з двома заповненими вимірами отримувала
  // повноцінну оцінку: о 09:00 «92» означало «я виспався», а виглядало як
  // підсумок доби, і далі число дрейфувало весь день. Тепер сервер віддає
  // null, поки вимірів менше за needCoverage — і це «ще рано», а не «немає
  // даних», тож екран мусить сказати саме так і назвати, чого бракує.
  if (last === null) {
    const cov = model.dayIndex.lastCoverage;
    const need = model.dayIndex.needCoverage;
    return (
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
          ІНДЕКС ДНЯ
        </span>
        <span className="text-[11.5px] leading-[1.5] text-tx2">
          Ще рано: заповнено {cov} із {need} потрібних напрямів. Оцінка доби зʼявиться, коли буде з
          чого її складати — інакше це був би підсумок дня, зроблений до обіду.
        </span>
      </div>
    );
  }

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
        Одне число 0–100 замість десятка окремих: усі відповіді чек-іну зведені в пʼять напрямів, а
        смуги показують, скільки кожен важить.{' '}
        {model.fit.learned
          ? `Ваги не задані наперед — модель вивела їх із твоїх ${model.fit.n} діб, звіряючись із тим, як ти сам оцінював день. Тобто це твоє означення хорошого дня, не чуже. ${cvNote(model.fit)}`
          : `Поки ваги однакові: щоб вивести саме твої, треба 20+ заповнених діб, зараз ${model.fit.n}.`}
      </Hint>
    </div>
  );
}
