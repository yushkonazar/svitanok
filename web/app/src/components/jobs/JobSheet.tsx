import { useJobStage } from '../../api/hooks.ts';
import { haptic, openLink } from '../../telegram.ts';
import { hostOf, prettyJobTitle } from '../../lib/jobTitle.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { FUNNEL_STAGES, STAGE_LABEL, fitStyle, isTerminal, type FunnelStage } from './stages.ts';
import type { StageEvent } from '../../api/schema.ts';
import type { KanbanCard } from './KanbanBoard.tsx';

// Шторка вакансії (дизайн v2, Svitanok.dc.html): затемнення + панель знизу
// (sheetUp), бейдж fit%, назва, домен, ІСТОРІЯ переходів, перевід на стадію.
//
// «Історія» з макета тепер справжня (F1): stats-core веде журнал переходів, і
// список тут — його пряме відображення, без домальовування. Легасі-вакансії
// (додані до F1) журналу не мають — тоді чесно показуємо лише дату входу.

/** 'YYYY-MM-DD' -> '06.07'. Журнал зберігає київський день, не ISO-мить. */
const dayShort = (key: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[3]}.${m[2]}` : key;
};

/** Таймлайн переходів: крапка-лінія + стадія + дата (макет: «ІСТОРІЯ»). */
function History({ events }: { events: StageEvent[] }) {
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => {
        const last = i === events.length - 1;
        return (
          <li key={`${e.stage}-${e.ts}-${i}`} className="flex gap-2.5">
            <div className="flex flex-none flex-col items-center">
              <div
                className="mt-1.5 h-[7px] w-[7px] rounded-full"
                style={{
                  background: last
                    ? isTerminal(e.stage)
                      ? 'var(--color-tx3)'
                      : 'var(--grad)'
                    : 'var(--color-glassb)',
                }}
              />
              {!last && <div className="w-px flex-1 bg-glassb" />}
            </div>
            <div className={last ? 'pb-0' : 'pb-2.5'}>
              <span className="text-[12.5px] font-semibold">{STAGE_LABEL[e.stage]}</span>
              <span className="ml-2 font-mono text-[10.5px] font-medium text-tx3">
                {dayShort(e.ts)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function JobSheet({ card, onClose }: { card: KanbanCard; onClose: () => void }) {
  const stageMut = useJobStage();
  const fit = card.score != null && card.score >= 0 ? fitStyle(card.score) : null;
  const host = hostOf(card.url);
  const ts = card.ts;

  const move = (stage: FunnelStage | null) => {
    haptic('light');
    stageMut.mutate({ url: card.url, title: card.title, stage });
    onClose();
  };

  return (
    <Sheet onClose={onClose} label="Вакансія">
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

      {/* Історія — журнал переходів (F1). У вакансій, доданих до F1, його немає:
            тоді чесно показуємо лише дату входу, нічого не домальовуючи. */}
      {card.history.length > 0 ? (
        <div className="mt-[18px]">
          <div className="mb-2.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-tx3">
            ІСТОРІЯ
          </div>
          <History events={card.history} />
        </div>
      ) : (
        ts && (
          <div className="mt-4 font-mono text-[10px] font-semibold tracking-[0.12em] text-tx3">
            У ВОРОНЦІ З {dayShort(ts)}
          </div>
        )
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
    </Sheet>
  );
}
