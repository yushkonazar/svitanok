import { FUNNEL_SHORT, FUNNEL_STAGES, type FunnelStage } from './stages.ts';

// Воронка (дизайн v2, Svitanok.dc.html): одна скляна смуга — 4 стадії з
// великими моно-лічильниками. Нульовий «Офер» приглушений, як у макеті.

export function FunnelWidget({ counts }: { counts: Record<FunnelStage, number> }) {
  return (
    <div className="flex items-stretch rounded-2xl border border-glassb bg-glass px-1.5 py-3.5">
      {FUNNEL_STAGES.map((s) => {
        const n = counts[s.key] || 0;
        return (
          <div key={s.key} className="flex flex-1 flex-col items-center gap-0.5">
            <span
              className="font-mono text-[26px] font-medium"
              style={{ color: n ? 'var(--color-tx)' : 'var(--color-tx3)' }}
            >
              {n}
            </span>
            <span className="text-[9.5px] font-medium text-tx2">{FUNNEL_SHORT[s.key]}</span>
          </div>
        );
      })}
    </div>
  );
}
