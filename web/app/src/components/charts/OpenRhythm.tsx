import type { Stats } from '../../api/schema.ts';
import { Hint } from '../ui/primitives.tsx';

// Ритуал відкриття — коробка з вусами (box plot) по хвилинах після 08:00.
//
// Чому саме box plot: ui-ux-pro-max (--domain chart, «Distribution/Statistical»)
// прямо називає його для «спреду, медіани й викидів», причому єдиний тип із
// поміткою «any sample size» — решта розподільних графіків вимагають 20+ точок,
// яких у щоденній звичці набирається місяцями. Плюс він компактний: на 375px
// це одна горизонтальна смуга, а не сітка.
//
// Обовʼязковий A11y-фолбек із того ж правила — «stats summary table
// (min/Q1/median/Q3/max)» — реалізований підписами під смугою: числа видно
// без наведення, графік лише додає форму.

/** хв після 08:00 -> «08:23». Понад добу не буває (кап на записі). */
function clockLabel(min: number): string {
  const total = 8 * 60 + Math.max(0, min);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Розкид середньої половини діб -> людське означення сталості. */
function spreadWord(iqr: number): string {
  if (iqr <= 20) return 'майже за розкладом';
  if (iqr <= 45) return 'досить стабільно';
  if (iqr <= 90) return 'плаваюче';
  return 'щоразу по-різному';
}

const W = 300;
const H = 44;
const PAD = 6;

export function OpenRhythm({ rhythm }: { rhythm: Stats['openRhythm'] }) {
  if (!rhythm.ready) {
    return (
      <Hint>
        Ритм відкриття зʼявиться після {rhythm.needed ?? 5} діб — зараз {rhythm.n}. На меншій
        вибірці «стабільність» була б вигадкою.
      </Hint>
    );
  }

  const p10 = rhythm.p10 ?? 0;
  const p90 = rhythm.p90 ?? 0;
  const q1 = rhythm.q1 ?? 0;
  const q3 = rhythm.q3 ?? 0;
  const med = rhythm.median ?? 0;
  const iqr = rhythm.iqr ?? 0;

  // Шкала від вуса до вуса, з невеликим запасом, щоб коробка не липла до країв.
  const lo = p10;
  const hi = Math.max(p90, p10 + 1);
  const x = (v: number) => PAD + ((v - lo) / (hi - lo)) * (W - PAD * 2);
  const cy = 18;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-medium leading-none text-tx">
          {clockLabel(med)}
        </span>
        <span className="text-[11.5px] text-tx2">
          зазвичай відкриваю
          <span className="ml-1.5 font-mono text-[10.5px] text-tx3">±{iqr} хв</span>
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img"
        aria-label={`Медіана ${clockLabel(med)}, середня половина діб між ${clockLabel(q1)} і ${clockLabel(q3)}`}>
        {/* вуса p10..p90 */}
        <line x1={x(p10)} x2={x(p90)} y1={cy} y2={cy} stroke="var(--color-glassb)" strokeWidth="2" />
        <line x1={x(p10)} x2={x(p10)} y1={cy - 6} y2={cy + 6} stroke="var(--color-tx3)" strokeWidth="1.5" />
        <line x1={x(p90)} x2={x(p90)} y1={cy - 6} y2={cy + 6} stroke="var(--color-tx3)" strokeWidth="1.5" />
        {/* коробка q1..q3 — середня половина діб */}
        <rect
          x={x(q1)}
          y={cy - 9}
          width={Math.max(2, x(q3) - x(q1))}
          height={18}
          rx={5}
          fill="color-mix(in srgb, var(--color-a2) 26%, transparent)"
          stroke="var(--color-a2)"
          strokeWidth="1.2"
        />
        {/* медіана */}
        <line x1={x(med)} x2={x(med)} y1={cy - 11} y2={cy + 11} stroke="var(--color-a2)" strokeWidth="2.5" strokeLinecap="round" />
        {/* підписи-фолбек: числа читаються без графіка */}
        <text x={x(p10)} y={H - 2} fontSize="9" textAnchor="start" fill="var(--color-tx3)" fontFamily="var(--font-mono)">
          {clockLabel(p10)}
        </text>
        <text x={x(p90)} y={H - 2} fontSize="9" textAnchor="end" fill="var(--color-tx3)" fontFamily="var(--font-mono)">
          {clockLabel(p90)}
        </text>
      </svg>

      {/* Один рядок, що переноситься природно: на 375px три flex-колонки
          (слово / діапазон / лічильник) ламались у вузькі стовпчики. */}
      <div className="text-[11px] leading-[1.45] text-tx3">
        <span className="font-semibold text-tx2">{spreadWord(iqr)}</span> — половина діб між{' '}
        {clockLabel(q1)} і {clockLabel(q3)}
        {/* «діб ІЗ ВІДКРИТТЯМ», не просто «діб»: вибірка рахується в записах
            журналу (одна доба, коли застосунок відкривали), тож доба без
            жодного відкриття у це число не входить. Різниця мала на вигляд,
            але саме вона відрізняє «за 90 днів» від «за 90 разів». */}
        <span className="font-mono text-[10px]"> · {rhythm.n} діб із відкриттям</span>
      </div>
    </div>
  );
}
