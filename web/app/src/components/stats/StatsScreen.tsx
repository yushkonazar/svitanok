import { StateDashboard } from './StateDashboard.tsx';
import { useState } from 'react';
import { inTelegram } from '../../telegram.ts';
import { useStats } from '../../api/hooks.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';
import './state-dashboard.css';

export const statisticsPeriodKey = (privateMode: boolean) =>
  `svitanok.state-period.${privateMode ? 'private' : 'demo'}`;
function initialPeriod(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return [7, 30, 90].includes(value) ? value : 30;
  } catch {
    return 30;
  }
}

export function StatsScreen() {
  const key = statisticsPeriodKey(inTelegram());
  const [days, changeDays] = useState(() => initialPeriod(key));
  const setDays = (value: number) => {
    if (![7, 30, 90].includes(value)) return;
    changeDays(value);
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* Selection still works without browser storage. */
    }
  };
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
    <div className="state-dashboard">
      <StateDashboard s={s} days={days} setDays={setDays} />
      <details className="renewal-card">
        <summary className="cursor-pointer text-sm font-bold">Інтереси й робота Світанку</summary>
        <div className="mt-5 flex flex-col gap-6">
          <InterestsBlock s={s} />
          <ReliabilityBlock s={s} />
        </div>
      </details>
    </div>
  );
}
