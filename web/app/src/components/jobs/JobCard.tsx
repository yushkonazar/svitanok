import { useState } from 'react';
import type { JobItem } from '../../api/briefing-schema.ts';
import { useJobStage, useJobDismiss } from '../../api/hooks.ts';
import { has } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';
import { Badge, type Tone } from '../today/badges.tsx';
import { JOB_STAGES, type FunnelStage } from './stages.ts';

// Картка вакансії (роадмеп v3, E3) — 1:1 з index.html jobCard (2446-2471): бейдж
// fit%, заголовок-посилання, «чому» (розкриття), 5 кнопок стадій + «Не релевантно».

function scoreBadge(score: number) {
  if (score < 0) return <Badge tone="muted">оцінюється</Badge>;
  let tone: Tone = 'warn';
  if (score >= 80) tone = 'fit';
  else if (score >= 50) tone = 'mid';
  return <Badge tone={tone}>{score}% fit</Badge>;
}

export function JobCard({
  item,
  curStage,
  onDismiss,
}: {
  item: JobItem;
  curStage: FunnelStage | null;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const stageMut = useJobStage();
  const dismissMut = useJobDismiss();

  const setStage = (key: FunnelStage | 'irrelevant') => {
    haptic('light');
    if (key === 'irrelevant') {
      // Ховаємо картку ЛИШЕ при успіху (як vanilla onOk) — при збої лишається.
      dismissMut.mutate(
        { url: item.url, title: item.title },
        { onSuccess: () => onDismiss(), onError: () => haptic('error') },
      );
      return;
    }
    // Тогл: повторний клік активної стадії — знімає (stage=null прибирає з воронки).
    const next = curStage === key ? null : key;
    stageMut.mutate({
      url: item.url,
      title: item.title,
      stage: next,
      ...(next === 'applied' && item.score >= 0 ? { fit: item.score } : {}),
    });
  };

  return (
    <section className="mb-3 rounded-card border border-border bg-surface p-4 shadow-lg">
      <div className="mb-1.5">{scoreBadge(item.score)}</div>

      <button
        type="button"
        onClick={() => {
          openLink(item.url);
          if (has(item.why)) setOpen((v) => !v);
        }}
        className="block text-left text-sm font-semibold"
      >
        {item.title}
      </button>

      {has(item.why) && open && <div className="mt-1 text-xs text-muted">{item.why}</div>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {JOB_STAGES.map((s) => {
          const on = curStage === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setStage(s.key)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                on ? 'bg-accent text-on-accent' : 'bg-surface-2 text-muted hover:bg-border'
              }`}
            >
              {s.short}
            </button>
          );
        })}
      </div>
    </section>
  );
}
