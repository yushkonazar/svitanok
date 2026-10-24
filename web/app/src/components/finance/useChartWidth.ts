import { useEffect, useRef, useState } from 'react';
export function useChartWidth(enabled = true) {
  const ref = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(320);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const resize = () => {
      const size = element.getBoundingClientRect().width;
      if (size > 0) setWidth(Math.max(260, Math.round(size)));
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [enabled]);
  return { ref, width };
}
export const axisMoney = (minor: number) =>
  new Intl.NumberFormat('uk-UA', { notation: 'compact', maximumFractionDigits: 1 }).format(
    minor / 100,
  );
