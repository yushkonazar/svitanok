import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inTelegram } from '../telegram.ts';
import {
  fetchStats,
  fetchBriefing,
  postEvent,
  postVote,
  type StatsResult,
  type VoteDir,
} from './client.ts';

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

// ── E3: Новини + Вакансії ──

/** Голос за новину (👍/👎). Оптимістично + звірка з авторитетним voted сервера. */
export function useVote() {
  const qc = useQueryClient();
  return useMutation({
    // Лише запит; оптимістичне значення рахуємо в onMutate (де кеш ще НЕ змінено).
    mutationFn: (vars: { category: string; dir: 'up' | 'down'; url: string }) =>
      postVote(vars.category, vars.dir, vars.url),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      const cur = prev?.stats.votes?.[vars.url] ?? null;
      // applyUrlVote-логіка: той самий напрямок вимикає (null), інший — перемикає.
      const optimistic: VoteDir = cur === vars.dir ? null : vars.dir;
      setVote(qc, vars.url, optimistic);
      return { prev, optimistic };
    },
    onSuccess: (data, vars, ctx) => {
      // У Telegram — авторитетний voted сервера; у демо (data=null) — оптимістичний.
      setVote(qc, vars.url, data ? data.voted : (ctx?.optimistic ?? null));
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stats'], ctx.prev);
    },
    onSettled: () => {
      if (inTelegram()) qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

function setVote(qc: ReturnType<typeof useQueryClient>, url: string, dir: VoteDir) {
  patchStats(qc, (s) => {
    const votes = { ...(s.votes ?? {}) };
    if (dir) votes[url] = dir;
    else delete votes[url];
    return { ...s, votes };
  });
}

/** Тогл 🔖 для новини (save_news / unsave_news; kind='news', id=url). */
export function useToggleSaveNews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { save: boolean; url: string; title: string; category: string }) =>
      postEvent(vars.save ? 'save_news' : 'unsave_news', {
        url: vars.url,
        title: vars.title,
        category: vars.category,
      }),
    onMutate: async ({ save, url, title }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => {
        const exists = s.savedList.some((x) => x.kind === 'news' && x.id === url);
        if (save) {
          if (exists) return s;
          return {
            ...s,
            savedCount: s.savedCount + 1,
            savedList: [{ kind: 'news', id: url, title, url, ts: '' }, ...s.savedList],
          };
        }
        return {
          ...s,
          savedCount: exists ? Math.max(0, s.savedCount - 1) : s.savedCount,
          savedList: s.savedList.filter((x) => !(x.kind === 'news' && x.id === url)),
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

/** Встановити/зняти стадію воронки для вакансії (job_stage; stage=null прибирає). */
export function useJobStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      url: string;
      title: string;
      stage: 'saved' | 'applied' | 'interview' | 'offer' | null;
      fit?: number;
    }) =>
      postEvent('job_stage', {
        url: vars.url,
        title: vars.title,
        stage: vars.stage,
        ...(vars.fit != null ? { fit: vars.fit } : {}),
      }),
    onMutate: async ({ url, title, stage }) => {
      await qc.cancelQueries({ queryKey: ['stats'] });
      const prev = qc.getQueryData<StatsResult>(['stats']);
      patchStats(qc, (s) => {
        let list = s.funnelList.filter((x) => x.url !== url);
        if (stage) list = [{ url, stage, title: title || '', ts: '' }, ...list];
        const funnel = { saved: 0, applied: 0, interview: 0, offer: 0 };
        for (const x of list) if (funnel[x.stage] != null) funnel[x.stage]++;
        return { ...s, funnelList: list, funnel };
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

/** Відхилити вакансію (job_dismiss) — ефемерне, не чіпає stats; ховання локальне. */
export function useJobDismiss() {
  return useMutation({
    mutationFn: (vars: { url: string; title: string }) => postEvent('job_dismiss', vars),
  });
}
