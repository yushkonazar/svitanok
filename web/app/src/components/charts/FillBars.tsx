import type { Stats } from '../../api/schema.ts';
import { Hint } from '../ui/primitives.tsx';

// Явка по слотах. Пропуски — теж дані: ранок заповнений 18 разів проти
// вечора 7 каже більше, ніж самі відповіді. Але це ще й ПРЯМЕ пояснення, чому
// «Індекс дня» вище по вечірніх полях мовчить: половина моделі (output,
// autonomy, rumination, moved…) живе саме у вечірньому блоці.
//
// Тому картка не просто рахує — вона називає найслабший слот і те, що з нього
// втрачається. Смуга + число, не лише смуга (не покладаємось на самий колір).

const SLOT_LABEL: Record<string, string> = {
  morning: '🌅 Ранок',
  afternoon: '☀️ Післяобід',
  evening: '🌙 Вечір',
};

export function FillBars({ fill }: { fill: Stats['checkinFill'] }) {
  const rows = (['morning', 'afternoon', 'evening'] as const).map((slot) => ({
    slot,
    n: fill[slot],
    pct: fill.days > 0 ? Math.round((fill[slot] / fill.days) * 100) : 0,
  }));
  const weakest = rows.reduce((a, b) => (b.n < a.n ? b : a), rows[0]!);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.slot} className="flex items-center gap-2">
            <span className="w-[86px] flex-none text-[11.5px] font-medium text-tx2">
              {SLOT_LABEL[r.slot]}
            </span>
            <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-track">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${r.pct}%`,
                  background: r.slot === weakest.slot ? 'var(--color-neg)' : 'var(--color-a2)',
                  opacity: r.slot === weakest.slot ? 0.75 : 1,
                }}
              />
            </div>
            <span className="w-[48px] flex-none text-right font-mono text-[10.5px] text-tx3">
              {r.n}/{fill.days}
            </span>
          </div>
        ))}
      </div>
      <Hint>
        Скільки діб із {fill.days} ти заповнював кожен блок. Пропуски — теж дані: вони кажуть,
        коли тобі не до чек-іну.
        {weakest.slot === 'evening' && weakest.pct < 60 && (
          <>
            {' '}
            Вечір заповнюється найрідше — а саме там живе більшість полів моделі (результат,
            автономія, румінація, рух). Що менше вечорів, то обережніший «Індекс дня».
          </>
        )}
      </Hint>
    </div>
  );
}
