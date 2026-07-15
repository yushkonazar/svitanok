import { useStats } from '../../api/hooks.ts';
import { HabitsBlock } from './HabitsBlock.tsx';
import { FunnelGoalBlock } from './FunnelGoalBlock.tsx';
import { MasteryBlock } from './MasteryBlock.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';

// Вкладка «Статистика» (роадмеп v3, E1). Стани: завантаження -> скелетони,
// помилка (5xx/мережа/дрейф контракту) -> картка з ретраєм, дані -> 5 блоків.
// Демо/не-власник -> SAMPLE (client.ts), рендериться як звичайні дані.

function Skeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-card border border-border bg-surface" />
      ))}
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-border bg-surface p-6 text-center">
      <div className="mb-1 text-2xl">⚠️</div>
      <div className="mb-3 text-sm text-muted">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full bg-surface-2 px-4 py-1.5 text-sm font-medium transition-colors hover:bg-border"
      >
        Спробувати ще
      </button>
    </div>
  );
}

export function StatsScreen() {
  const { data, isLoading, isError, error, refetch } = useStats();

  if (isLoading) return <Skeleton />;
  if (isError || !data) {
    const msg = error instanceof Error ? error.message : 'Не вдалося завантажити статистику';
    return <ErrorCard message={msg} onRetry={() => refetch()} />;
  }

  const s = data.stats;
  return (
    <div>
      <HabitsBlock s={s} />
      <FunnelGoalBlock s={s} />
      <MasteryBlock s={s} />
      <InterestsBlock s={s} />
      <ReliabilityBlock s={s} />
    </div>
  );
}
