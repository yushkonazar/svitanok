import { FUNNEL_SHORT, FUNNEL_STAGES, isTerminal, type FunnelStage } from './stages.ts';
import { useInView } from '../../lib/useInView.ts';
import { CountUp } from '../ui/CountUp.tsx';

// Воронка (дизайн v2, Svitanok.dc.html): одна скляна смуга — стадії з великими
// моно-лічильниками. Нульовий «Офер» приглушений, як у макеті.
//
// Показуємо лише ЛІНІЙНІ 4 стадії. Термінальні (F1) сюди не ставимо з двох
// причин: 6 колонок на 375px перетворюють числа на кашу, і, головне, віджет
// відповідає на питання «де я зараз», а відмова — це вже не «зараз». Вони йдуть
// окремим приглушеним рядком і лише коли справді є.

export function FunnelWidget({ counts }: { counts: Record<FunnelStage, number> }) {
  // Лічильники набігають від нуля при відкритті вкладки (віджет угорі, тож
  // useInView тут — про запас, для консистентності з рештою «оживлених» чисел).
  const [ref, inView] = useInView<HTMLDivElement>();
  const closed = (counts.rejected || 0) + (counts.failed || 0);

  return (
    <div ref={ref} className="flex flex-col gap-2 rounded-2xl border border-glassb bg-glass px-1.5 py-3.5">
      <div className="flex items-stretch">
        {FUNNEL_STAGES.filter((s) => !isTerminal(s.key)).map((s) => {
          const n = counts[s.key] || 0;
          return (
            <div key={s.key} className="flex flex-1 flex-col items-center gap-0.5">
              <CountUp
                n={n}
                play={inView}
                className="font-mono text-[26px] font-medium"
                style={{ color: n ? 'var(--color-tx)' : 'var(--color-tx3)' }}
              />
              <span className="text-[9.5px] font-medium text-tx2">{FUNNEL_SHORT[s.key]}</span>
            </div>
          );
        })}
      </div>

      {closed > 0 && (
        <div className="border-t border-hair pt-2 text-center font-mono text-[10px] font-medium text-tx3">
          ЗАКРИТО: {counts.rejected || 0} ВІДМОВ · {counts.failed || 0} ПРОВАЛ(ІВ)
        </div>
      )}
    </div>
  );
}
