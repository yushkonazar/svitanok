import { ObservationReview } from './ObservationReview.tsx';
import { useState } from 'react';
import { PageHeading } from '../ui/PageHeading.tsx';
import { useStats } from '../../api/hooks.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';
import { HistoryBlock } from './HistoryBlock.tsx';

export function StatsScreen() {
  const [days, setDays] = useState(7);
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
      <PageHeading
        eyebrow="ЩО ЗМІНЮЄТЬСЯ В ТОБІ"
        title="Не просто числа."
        accent="Твій ритм."
        description="Від щоденних відповідей до змін, які можна помітити."
      />
      <ObservationReview s={s} days={days} setDays={setDays} />
      <details className="renewal-card">
        <summary className="cursor-pointer text-sm font-bold">Інтереси й робота Світанку</summary>
        <div className="mt-5 flex flex-col gap-6">
          <InterestsBlock s={s} />
          <ReliabilityBlock s={s} />
        </div>
      </details>
      <HistoryBlock />
    </div>
  );
}
