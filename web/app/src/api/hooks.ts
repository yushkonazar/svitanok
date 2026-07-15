import { useQuery } from '@tanstack/react-query';
import { fetchStats } from './client.ts';

// TanStack Query хуки даних дашборда (роадмеп v3, E1). Дефолти (staleTime 60с,
// retry 1) — у main.tsx. Мутації (збереження/голос/стадія воронки) далі
// інвалідуватимуть ['stats'] для авто-оновлення.

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
  });
}
