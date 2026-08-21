import { useState } from 'react';
import type { Stats } from '../../api/schema.ts';
import { haptic } from '../../telegram.ts';
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

/** 'YYYY-MM-DD' -> 'дд.мм'. */
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/**
 * Пропущені доби слоту, сусідні згорнуті в діапазон.
 *
 * ⚠️ Згортання не косметичне: за 30 діб пропусків може бути двадцять, і плаский
 * список дат — це стіна цифр, у якій нічого не видно. «5–8 серпня» одразу
 * читається як провал у чотири доби, а чотири окремі дати — як чотири випадки.
 */
function missedRanges(
  raw: Stats['checkinRaw'],
  slot: 'morning' | 'afternoon' | 'evening',
  days: number,
) {
  const all = Object.keys(raw.records).sort();
  if (!all.length) return [];
  // Вікно рахуємо від СЬОГОДНІ назад, а не від першого запису: картка каже
  // «з останніх N діб», і список мусить означати те саме.
  const to = raw.to;
  const from = new Date(to + 'T00:00:00Z');
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const out: string[][] = [];
  const d = new Date(from);
  const end = new Date(to + 'T00:00:00Z');
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const rec = raw.records[key];
    const filled = rec && rec[slot] && Object.keys(rec[slot]!).length > 0;
    if (filled) continue;
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    if (prev) {
      const p = new Date(prev + 'T00:00:00Z');
      p.setUTCDate(p.getUTCDate() + 1);
      if (p.toISOString().slice(0, 10) === key) {
        last.push(key);
        continue;
      }
    }
    out.push([key]);
  }
  return out.map((run) =>
    run.length === 1 ? dm(run[0]!) : `${dm(run[0]!)}–${dm(run[run.length - 1]!)}`,
  );
}

export function FillBars({ fill, raw }: { fill: Stats['checkinFill']; raw?: Stats['checkinRaw'] }) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const rows = (['morning', 'afternoon', 'evening'] as const).map((slot) => ({
    slot,
    n: fill[slot],
    pct: fill.days > 0 ? Math.round((fill[slot] / fill.days) * 100) : 0,
  }));
  const weakest = rows.reduce((a, b) => (b.n < a.n ? b : a), rows[0]!);
  const missed = raw && openSlot ? missedRanges(raw, openSlot as 'morning', fill.days) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.slot} className="flex flex-col gap-1">
            {/* ⚠️ Рядок став кнопкою: власник просив показувати ДНІ, у які слот
                пропущено. Дані для цього вже на клієнті (checkinRaw), тобто
                бракувало не інформації, а місця, де її показати. */}
            <button
              type="button"
              disabled={!raw}
              aria-expanded={openSlot === r.slot}
              onClick={() => {
                haptic('light');
                setOpenSlot(openSlot === r.slot ? null : r.slot);
              }}
              className="flex items-center gap-2 text-left"
            >
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
            </button>
            {openSlot === r.slot && (
              <div className="rounded-xl border border-glassb bg-glass px-2.5 py-1.5 font-mono text-[9.5px] leading-[1.5] text-tx3">
                {missed && missed.length > 0 ? (
                  <>пропущено: {missed.join(' · ')}</>
                ) : (
                  <>жодного пропуску за {fill.days} діб</>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <Hint>
        Скільки діб із {fill.days} ти заповнював кожен блок. Пропуски — теж дані: вони кажуть, коли
        тобі не до чек-іну.
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
