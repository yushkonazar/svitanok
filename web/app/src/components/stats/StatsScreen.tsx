import { useStats } from '../../api/hooks.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { HabitsBlock } from './HabitsBlock.tsx';
import { FunnelGoalBlock } from './FunnelGoalBlock.tsx';
import { MasteryBlock } from './MasteryBlock.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';

// Вкладка «Статистика» (дизайн v2, Svitanok.dc.html): 5 секцій із ритмом 26px,
// кожна — заголовок із градієнтною крапкою та волосінню.

export function StatsScreen() {
  const { data, isLoading, isError, error, refetch } = useStats();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Не вдалося завантажити статистику'}
        onRetry={() => refetch()}
      />
    );
  }

  const s = data.stats;
  return (
    <div className="flex flex-col gap-[26px]">
      <HabitsBlock s={s} />
      <FunnelGoalBlock s={s} />
      <MasteryBlock s={s} />
      <InterestsBlock s={s} />
      <ReliabilityBlock s={s} />
    </div>
  );
}
