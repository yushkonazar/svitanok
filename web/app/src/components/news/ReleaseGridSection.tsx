import type { NewsGroup as NewsGroupT, NewsItem as NewsItemT } from '../../api/briefing-schema.ts';
import { releaseRepo, releaseVersionLabel } from '../../lib/newsSource.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { openLink, haptic } from '../../telegram.ts';
import { GlassCard } from '../ui/primitives.tsx';

// Релізи — ЗАВЖДИ окрема секція (незалежно від рангу ваги), видно одразу на
// екрані (не за тапом): репо+версія+час, без "чому"/❤️/🔖 (це версія, не
// стаття). Один репо -> ОДНА плитка з його найновішим релізом (фідбек
// власника, фото 1): без цього репо з частими тегами (напр. TypeScript,
// кілька релізів+RC одразу) займало по 2-3 слоти й обрізало назву в "Ty…",
// поки решта репо не влазила. Показуємо перші VISIBLE, "Показати всі"
// відкриває Sheet з повною історією (усіх тегів, не лише останнього).

const VISIBLE = 4;

export function ReleaseGridSection({
  group,
  onOpenAll,
}: {
  group: NewsGroupT;
  onOpenAll: () => void;
}) {
  const latestByRepo = new Map<string, NewsItemT>();
  for (const it of [...group.items, ...group.more]) {
    const repo = releaseRepo(it.url);
    const prev = latestByRepo.get(repo);
    const t = it.publishedAt ? Date.parse(it.publishedAt) : -Infinity;
    const prevT = prev?.publishedAt ? Date.parse(prev.publishedAt) : -Infinity;
    if (!prev || t > prevT) latestByRepo.set(repo, it);
  }
  const latest = [...latestByRepo.entries()].sort(([, a], [, b]) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
    return tb - ta;
  });
  const shown = latest.slice(0, VISIBLE);
  if (shown.length === 0) return null;

  return (
    <GlassCard className="p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-base">📦</span>
        <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-tx2">
          IT РЕЛІЗИ
        </span>
        <span className="ml-auto font-mono text-[10px] font-semibold text-tx3">
          {latest.length} репо
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {shown.map(([repo, it]) => {
          const name = repo.includes('/') ? repo.split('/')[1] : repo;
          const version = releaseVersionLabel(it.title, repo);
          const ago = timeAgo(it.publishedAt);
          return (
            <button
              key={repo}
              type="button"
              onClick={() => {
                haptic('light');
                openLink(it.url);
              }}
              className="rounded-xl border border-glassb bg-bg2 p-2.5 text-left"
            >
              <div className="truncate text-[12px] font-bold">{name}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate rounded-md bg-glass px-1.5 py-0.5 font-mono text-[9px] font-semibold text-tx2">
                  {version}
                </span>
                {ago && <span className="flex-none font-mono text-[9.5px] text-tx3">{ago}</span>}
              </div>
            </button>
          );
        })}
      </div>
      {latest.length > VISIBLE && (
        <button
          type="button"
          onClick={() => {
            haptic('light');
            onOpenAll();
          }}
          className="mt-2.5 self-start whitespace-nowrap rounded-full border border-glassb bg-glass px-[13px] py-1.5 text-[11px] font-semibold text-tx2"
        >
          Показати всі ({latest.length})
        </button>
      )}
    </GlassCard>
  );
}
