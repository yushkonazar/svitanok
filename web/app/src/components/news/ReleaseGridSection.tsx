import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { releaseRepo } from '../../lib/newsSource.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { openLink, haptic } from '../../telegram.ts';
import { GlassCard } from '../ui/primitives.tsx';

// Релізи — ЗАВЖДИ окрема секція (незалежно від рангу ваги), видно одразу на
// екрані (не за тапом): репо+версія+час, без "чому"/❤️/🔖 (це версія, не
// стаття). Показуємо перші VISIBLE, "Показати всі" відкриває Sheet із рештою.

const VISIBLE = 4;

export function ReleaseGridSection({
  group,
  onOpenAll,
}: {
  group: NewsGroupT;
  onOpenAll: () => void;
}) {
  const all = [...group.items, ...group.more];
  const shown = all.slice(0, VISIBLE);
  if (shown.length === 0) return null;

  return (
    <GlassCard className="p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-base">📦</span>
        <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-tx2">
          IT РЕЛІЗИ
        </span>
        <span className="ml-auto font-mono text-[10px] font-semibold text-tx3">
          {all.length} репо
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {shown.map((it) => {
          const repo = releaseRepo(it.url);
          const name = repo.includes('/') ? repo.split('/')[1] : repo;
          const ago = timeAgo(it.publishedAt);
          return (
            <button
              key={it.url}
              type="button"
              onClick={() => {
                haptic('light');
                openLink(it.url);
              }}
              className="rounded-xl border border-glassb bg-bg2 p-2.5 text-left"
            >
              <div className="flex items-center justify-between gap-1.5">
                <span className="truncate text-[12px] font-bold">{name}</span>
                <span className="flex-none truncate rounded-md bg-glass px-1.5 py-0.5 font-mono text-[9px] font-semibold text-tx2">
                  {it.title}
                </span>
              </div>
              {ago && <div className="mt-1 font-mono text-[9.5px] text-tx3">{ago}</div>}
            </button>
          );
        })}
      </div>
      {all.length > VISIBLE && (
        <button
          type="button"
          onClick={() => {
            haptic('light');
            onOpenAll();
          }}
          className="mt-2.5 self-start whitespace-nowrap rounded-full border border-glassb bg-glass px-[13px] py-1.5 text-[11px] font-semibold text-tx2"
        >
          Показати всі ({all.length})
        </button>
      )}
    </GlassCard>
  );
}
