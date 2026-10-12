import { useQuery } from '@tanstack/react-query';
import { fetchFinance } from './client.ts';
export const FINANCE_QUERY = ['finance'] as const;
export function useFinance(enabled = true) {
  return useQuery({
    queryKey: FINANCE_QUERY,
    queryFn: fetchFinance,
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled
      ? (query) => (query.state.data?.finance.bankSync?.active ? 3000 : 60000)
      : false,
    refetchOnWindowFocus: 'always',
  });
}
