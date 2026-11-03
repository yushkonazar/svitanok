import { useEffect, useRef, type ReactNode } from 'react';
import { usePresentation } from '../../lib/presentation.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';

/** An exact new value appears immediately; only a subsequent data change gets an accent. */
export function UpdatedValue({
  value,
  identity,
  enabled = true,
  children,
}: {
  value: number | null;
  identity: string;
  enabled?: boolean;
  children: ReactNode;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef({ value, identity });
  const { calm } = usePresentation();
  const reduced = useReducedMotion();
  useEffect(() => {
    const old = previous.current;
    previous.current = { value, identity };
    if (
      !enabled ||
      calm ||
      reduced ||
      old.identity !== identity ||
      old.value === value ||
      old.value == null ||
      value == null ||
      !Number.isFinite(old.value) ||
      !Number.isFinite(value)
    )
      return;
    const animation = element.current?.animate?.(
      [
        { backgroundColor: 'rgba(255,164,92,.24)', boxShadow: '0 0 0 5px rgba(255,164,92,.10)' },
        { backgroundColor: 'transparent', boxShadow: '0 0 0 5px transparent' },
      ],
      { duration: 850, easing: 'ease-out' },
    );
    return () => animation?.cancel();
  }, [value, identity, enabled, calm, reduced]);
  return (
    <span ref={element} className="today-updated-value">
      {children}
    </span>
  );
}
