import { useBriefing } from '../../api/hooks.ts';
import { WeatherCard } from './WeatherCard.tsx';
import { CurrencyCard } from './CurrencyCard.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { FactCard, ThoughtCard } from './FactCard.tsx';
import { OnThisDayCard } from './OnThisDayCard.tsx';

// Вкладка «Сьогодні» (роадмеп v3, E2). Порядок карток 1:1 з vanilla renderToday
// (index.html:1714-1817): Погода → Курс → Питання → Факт → Думка → У цей день.

function Skeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-card border border-border bg-surface" />
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

export function TodayScreen() {
  const { data, isLoading, isError, error, refetch } = useBriefing();

  if (isLoading) return <Skeleton />;
  if (isError || !data) {
    const msg = error instanceof Error ? error.message : 'Не вдалося завантажити брифінг';
    return <ErrorCard message={msg} onRetry={() => refetch()} />;
  }

  const { brief } = data;
  return (
    <div>
      {brief.dateLabel && (
        <div className="mb-3 text-sm text-muted">{brief.dateLabel}</div>
      )}
      <WeatherCard brief={brief} />
      <CurrencyCard brief={brief} />
      <QuestionCard brief={brief} />
      <FactCard brief={brief} />
      <ThoughtCard brief={brief} />
      <OnThisDayCard brief={brief} />
    </div>
  );
}
