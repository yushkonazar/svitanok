import { useEffect, useState } from 'react';

// Живий тик (роадмеп v3, E2) — форсує ре-рендер що intervalMs і при поверненні
// фокуса на апку. Для циферблата погоди (маркер повзе, відлік цокає, автоперехід
// день↔ніч), як vanilla tickDials (index.html:1996). Пауза, коли вкладка прихована.

export function useTick(intervalMs: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => {
      if (!document.hidden) setN((x) => x + 1);
    };
    const id = setInterval(bump, intervalMs);
    document.addEventListener('visibilitychange', bump);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', bump);
    };
  }, [intervalMs]);
  return n;
}
