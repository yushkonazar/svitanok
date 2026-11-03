import { useEffect } from 'react';
import { useMutationState } from '@tanstack/react-query';
import type { useStats } from '../api/hooks.ts';
import { isSessionExpired } from '../api/client.ts';
import { checkinDayProgress, checkinServerNow, type PendingCheckin } from './checkinProgress.ts';

type Query = Pick<
  ReturnType<typeof useStats>,
  'data' | 'dataUpdatedAt' | 'error' | 'refetch' | 'isError'
>;
export function useCheckinProgress(query: Query, now: number) {
  const confirmations = useMutationState({
    filters: { status: 'pending', predicate: (m) => m.options.scope?.id === 'checkin-write' },
    select: (m) => {
      const v = m.state.variables as
        (PendingCheckin & { answers?: { confirmed?: boolean } }) | undefined;
      return v?.answers?.confirmed === true ? { slot: v.slot, dateKey: v.dateKey } : null;
    },
  });
  const pending: PendingCheckin[] = confirmations.filter((v) => v != null);
  const data = isSessionExpired(query.error) ? undefined : query.data;
  const serverNow = checkinServerNow(data, query.dataUpdatedAt ?? now, now);
  const { refetch, isError } = query;
  useEffect(() => {
    if (!data?.stats.checkinWindows || data.demo || isError || !refetch) return;
    const current = checkinServerNow(data, query.dataUpdatedAt, Date.now());
    const next = data.stats.checkinWindows
      .flatMap((w) => [Date.parse(w.startAt), Date.parse(w.endAt)])
      .filter((ms) => ms > current)
      .sort((a, b) => a - b)[0];
    if (!next) return;
    const timer = setTimeout(() => void refetch(), Math.min(2147483647, next - current + 100));
    return () => clearTimeout(timer);
  }, [data, query.dataUpdatedAt, refetch, isError]);
  return {
    serverNow,
    pending,
    progress: data ? checkinDayProgress(data.stats, serverNow, undefined, pending) : null,
  };
}
