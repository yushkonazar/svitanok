import { useLayoutEffect, useRef } from 'react';
import type { MapBox } from './historyMap.ts';

/** Animate the SVG camera directly: the land path and React tree are not rebuilt each frame. */
export function useMapCamera(box: MapBox, motion: boolean) {
  const element = useRef<SVGSVGElement>(null);
  const frame = useRef(box);
  const { x, y, width, height } = box;
  useLayoutEffect(() => {
    const svg = element.current;
    if (!svg) return;
    const from = { ...frame.current };
    // Keep repeated trips across the date line in the three rendered world copies.
    from.x -= Math.floor((from.x + from.width / 2) / 360) * 360;
    const target = { x, y, width, height };
    target.x += 360 * Math.round((from.x + from.width / 2 - (x + width / 2)) / 360);
    const paint = (value: MapBox) => {
      frame.current = value;
      svg.setAttribute('viewBox', [value.x, value.y, value.width, value.height].join(' '));
    };
    if (
      !motion ||
      Object.keys(target).every((key) => target[key as keyof MapBox] === from[key as keyof MapBox])
    ) {
      paint(target);
      return;
    }
    paint(from);
    let started: number | undefined;
    let raf = 0;
    const tick = (now: number) => {
      started ??= now;
      const progress = Math.min(1, (now - started) / 260);
      const eased = 1 - (1 - progress) ** 3;
      paint({
        x: from.x + (target.x - from.x) * eased,
        y: from.y + (target.y - from.y) * eased,
        width: from.width + (target.width - from.width) * eased,
        height: from.height + (target.height - from.height) * eased,
      });
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [x, y, width, height, motion]);
  return element;
}
