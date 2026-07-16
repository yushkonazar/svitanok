import type { JobItem } from '../../api/briefing-schema.ts';
import { useJobStage, useJobDismiss } from '../../api/hooks.ts';
import { has } from '../../lib/format.ts';
import { hostOf } from '../../lib/jobTitle.ts';
import { openLink, haptic } from '../../telegram.ts';
import { FUNNEL_STAGES, STAGE_LABEL, fitStyle, type FunnelStage } from './stages.ts';

// Картка вакансії (дизайн v2, Svitanok.dc.html): скляна картка — рядок бейджа
// fit% + назва стадії праворуч; заголовок + домен; кнопки стадій + «Відхилити».
// «Відхилити» = job_dismiss (ефемерне ховання), бо термінальних стадій
// rejected/failed бекенд поки не знає — вони прийдуть із воронкою v2.
// `why` (пояснення скорера) макет не показує, але це цінна інформація — лишаємо
// тихим рядком під доменом.

export function JobCard({
  item,
  curStage,
  onDismiss,
}: {
  item: JobItem;
  curStage: FunnelStage | null;
  onDismiss: () => void;
}) {
  const stageMut = useJobStage();
  const dismissMut = useJobDismiss();
  const fit = fitStyle(item.score);
  const host = hostOf(item.url);

  const setStage = (key: FunnelStage) => {
    haptic('light');
    // Тогл: повторний клік активної стадії прибирає з воронки (stage=null).
    const next = curStage === key ? null : key;
    stageMut.mutate({
      url: item.url,
      title: item.title,
      stage: next,
      ...(next === 'applied' && item.score >= 0 ? { fit: item.score } : {}),
    });
  };

  const dismiss = () => {
    haptic('light');
    // Ховаємо ЛИШЕ при успіху (як vanilla onOk) — при збої картка лишається.
    dismissMut.mutate(
      { url: item.url, title: item.title },
      { onSuccess: () => onDismiss(), onError: () => haptic('error') },
    );
  };

  const btn = (key: string, label: string, on: boolean, onClick: () => void, danger = false) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-[7px] text-[11px] font-semibold transition-colors"
      style={
        on
          ? danger
            ? { background: 'rgba(255,120,120,.12)', border: '1px solid var(--color-neg)', color: 'var(--color-neg)' }
            : { background: 'var(--grad)', color: 'var(--color-onacc)' }
          : {
              background: 'var(--color-glass)',
              border: '1px solid var(--color-glassb)',
              color: danger ? 'var(--color-tx3)' : 'var(--color-tx2)',
            }
      }
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-glassb bg-glass p-3.5">
      <div className="flex items-center gap-2">
        <span
          className="rounded-full border px-[9px] py-[3px] font-mono text-[10px] font-bold"
          style={{ color: fit.tx, background: fit.bg, borderColor: fit.brd }}
        >
          {fit.label}
        </span>
        <span className="ml-auto font-mono text-[10px] font-medium text-tx3">
          {curStage ? STAGE_LABEL[curStage] : ''}
        </span>
      </div>

      <div className="flex flex-col gap-px">
        <button
          type="button"
          onClick={() => openLink(item.url)}
          className="text-left text-[15px] font-bold tracking-[-0.01em]"
        >
          {item.title}
        </button>
        {host && <div className="font-mono text-[11px] font-medium text-tx2">{host}</div>}
        {has(item.why) && (
          <div className="mt-1 text-[11.5px] leading-[1.45] text-tx3">{item.why}</div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FUNNEL_STAGES.map((s) => btn(s.key, s.short, curStage === s.key, () => setStage(s.key)))}
        {btn('dismiss', 'Відхилити', false, dismiss, true)}
      </div>
    </div>
  );
}
