import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inTelegram } from '../telegram.ts';
import { fetchStats, fetchBriefing, postEvent, type StatsResult } from './client.ts';

// TanStack Query хуки даних дашборда (роадмеп v3, E1+E2). Дефолти (staleTime 60с,
// retry 1) — у main.tsx. Дві незалежні черги: ['brief'] (щоденний знімок) і
// ['stats'] (агрегат). Мутації чіпають ЛИШЕ ['stats'] — контент брифінгу не
// похідний від подій. Оптимістичне оновлення кешу дає миттєвий відгук і працює
// в демо (де postEvent — no-op, тож інвалідацію пропускаємо, щоб зміна лишилась).

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: fetchStats });
}

export function useBriefing() {
  return useQuery({ queryKey: ['brief'], queryFn: fetchBriefing });
}

/** Оновити ['stats'] в кеші, зберігши обгортку StatsResult. */
function patchStats(
  qc: ReturnType<typeof useQueryClient>,
  fn: (s: StatsResult['stats']) => StatsResult['stats'],
) {
  qc.setQueryData<StatsResult>(['stats'], (old) =>
    old ? { ...old, stats: fn(old.stats) } : old,
  );
}

/** Оцінка питання дня (😌 Легко / 😰 Важко) — виставляє mockRatedToday. */
export function useMockAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { topic: string; rating: 'easy' | 'hard' }) =>
      postEvent('mock_answer', vars),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => ({ ...s, mockRatedToday: true }));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/** Тогл 🔖 для факту/цитати/питання (save_item / unsave_item). */
export function useToggleSaveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { save: boolean; kind: string; id: string; title: string }) =>
      postEvent(vars.save ? 'save_item' : 'unsave_item', {
        kind: vars.kind,
        id: vars.id,
        title: vars.title,
      }),
    onMutate: async ({ save, kind, id, title }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => {
        const exists = s.savedList.some((x) => x.kind === kind && x.id === id);
        if (save) {
          if (exists) return s;
          return {
            ...s,
            savedCount: s.savedCount + 1,
            savedList: [{ kind, id, title, url: null, ts: '' }, ...s.savedList],
          };
        }
        return {
          ...s,
          savedCount: exists ? Math.max(0, s.savedCount - 1) : s.savedCount,
          savedList: s.savedList.filter((x) => !(x.kind === kind && x.id === id)),
        };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}
