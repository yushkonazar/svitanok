import type { ReactNode } from 'react';
import { usePresentation } from '../../lib/presentation.ts';

/** Optional guidance only. Errors, units and missing-data warnings stay outside. */
export function Explanation({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const { explanations } = usePresentation();
  return explanations ? <p className={`renewal-chart-note ${className}`}>{children}</p> : null;
}
