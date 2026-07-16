import { useJobStage } from '../../api/hooks.ts';
import { haptic, openLink } from '../../telegram.ts';
import { hostOf, prettyJobTitle } from '../../lib/jobTitle.ts';
import { FUNNEL_STAGES, STAGE_LABEL, fitStyle, type FunnelStage } from './stages.ts';
import type { KanbanCard } from './KanbanBoard.tsx';

// Шторка вакансії (дизайн v2, Svitanok.dc.html): затемнення + панель знизу
// (sheetUp), бейдж fit%, назва, домен, перевід на стадію, прибрати з воронки.
//
// СВІДОМО без «ІСТОРІЇ» з макета: там таймлайн стадій із датами, але бекенд
// зберігає лише ПОТОЧНУ стадію + ts входу у воронку (funnelMeta) — повної
// історії переходів немає. Показуємо чесно «У воронці з {дата}»; повний таймлайн
// потребує журналу переходів у stats-core (окрема робота).

export function JobSheet({ card, ts, onClose }: { card: KanbanCard; ts: string; onClose: () => void }) {
  const stageMut = useJobStage();
  const fit = card.score != null && card.score >= 0 ? fitStyle(card.score) : null;
  const host = hostOf(card.url);

  const move = (stage: FunnelStage | null) => {
    haptic('light');
    stageMut.mutate({ url: card.url, title: card.title, stage });
    onClose();
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-end"
      style={{ background: 'rgba(6,4,12,.55)', animation: 'fadeIn .2s ease' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full px-5 pb-7 pt-2.5"
        style={{
          background: 'var(--color-bg2)',
          borderTop: '1px solid var(--color-glassb)',
          borderRadius: '26px 26px 0 0',
          animation: 'sheetUp .3s cubic-bezier(.2,.8,.2,1)',
          boxShadow: '0 -20px 60px rgba(0,0,0,.5)',
        }}
      >
        <div className="mx-auto mb-4 mt-1 h-1 w-[38px] rounded-full bg-glassb" />

        <div className="mb-1 flex items-center gap-2.5">
          {fit ? (
            <span
              className="rounded-full border px-[9px] py-[3px] font-mono text-[10px] font-bold"
              style={{ color: fit.tx, background: fit.bg, borderColor: fit.brd }}
            >
              {card.score}% fit
            </span>
          ) : (
            <span className="rounded-full border border-glassb bg-glass px-[9px] py-[3px] font-mono text-[10px] font-bold text-tx2">
              без оцінки
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] font-semibold text-tx3">
            {STAGE_LABEL[card.stage]}
          </span>
        </div>

        <button
          type="button"
          onClick={() => openLink(card.url)}
          className="block text-left text-lg font-extrabold leading-[1.25] tracking-[-0.01em]"
        >
          {prettyJobTitle(card.url, card.title)}
        </button>
        {host && <div className="mt-0.5 font-mono text-[11.5px] font-medium text-tx2">{host}</div>}

        {ts && (
          <div className="mt-4 font-mono text-[10px] font-semibold tracking-[0.12em] text-tx3">
            У ВОРОНЦІ З {ts}
          </div>
        )}

        <div className="mb-2.5 mt-[18px] font-mono text-[10px] font-semibold tracking-[0.12em] text-tx3">
          ПЕРЕВЕСТИ НА СТАДІЮ
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FUNNEL_STAGES.map((s) => {
            const on = card.stage === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => move(on ? null : s.key)}
                className="rounded-full px-3 py-[7px] text-[11px] font-semibold transition-colors"
                style={
                  on
                    ? { background: 'var(--grad)', color: 'var(--color-onacc)' }
                    : {
                        background: 'var(--color-glass)',
                        border: '1px solid var(--color-glassb)',
                        color: 'var(--color-tx2)',
                      }
                }
              >
                {s.short}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => move(null)}
            className="rounded-full px-3 py-[7px] text-[11px] font-semibold text-tx3"
            style={{ background: 'var(--color-glass)', border: '1px solid var(--color-glassb)' }}
          >
            Прибрати з воронки
          </button>
        </div>
      </div>
    </div>
  );
}
