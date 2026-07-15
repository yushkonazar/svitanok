import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useStats } from './api/hooks.ts';

// Session-sticky пам'ять збереженого (роадмеп v3, E2, за ревʼю) — відповідник
// vanilla ITEM_STATE + hydrateSaved (index.html:2233-2247, 2826-2833). Проблема:
// сервер віддає savedList обрізаним до top-8, тож today-елемент, витіснений
// свіжішими збереженнями, після refetch «губить» позначку і стає незнімним.
// Рішення: набір ключів kind:id, що ЛИШЕ доповнюється зі savedList (ніколи не
// знімає позначку через відсутність) + явні save/unsave. Так позначка лишається
// стабільною в межах сесії, як у vanilla.

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

interface SavedCtx {
  isSaved: (kind: string, id: string) => boolean;
  setSaved: (kind: string, id: string, value: boolean) => void;
}

const SavedContext = createContext<SavedCtx>({ isSaved: () => false, setSaved: () => {} });

export function SavedProvider({ children }: { children: ReactNode }) {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  const { data } = useStats();
  const savedList = data?.stats.savedList;

  // Додаткове (additive) вливання зі savedList — тільки додаємо ключі, ніколи не
  // прибираємо через відсутність (сервер міг обрізати список).
  useEffect(() => {
    if (!savedList || !savedList.length) return;
    setSet((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const x of savedList) {
        if (!x.id) continue;
        const k = keyOf(x.kind, x.id);
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [savedList]);

  const setSaved = useCallback((kind: string, id: string, value: boolean) => {
    setSet((prev) => {
      const k = keyOf(kind, id);
      if (prev.has(k) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(k);
      else next.delete(k);
      return next;
    });
  }, []);

  const isSaved = useCallback((kind: string, id: string) => set.has(keyOf(kind, id)), [set]);

  const value = useMemo(() => ({ isSaved, setSaved }), [isSaved, setSaved]);
  return <SavedContext.Provider value={value}>{children}</SavedContext.Provider>;
}

export const useSaved = () => useContext(SavedContext);
