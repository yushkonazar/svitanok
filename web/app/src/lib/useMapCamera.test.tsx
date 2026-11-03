import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMapCamera } from './useMapCamera.ts';
import type { MapBox } from './historyMap.ts';

const callbacks = new Map<number, FrameRequestCallback>();
let sequence = 0;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    callbacks.set(++sequence, fn);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
});
afterEach(() => {
  cleanup();
  callbacks.clear();
  vi.unstubAllGlobals();
});
function advance(time: number) {
  const queued = [...callbacks.values()];
  callbacks.clear();
  act(() => queued.forEach((fn) => fn(time)));
}
function Camera({ box, motion = true }: { box: MapBox; motion?: boolean }) {
  const ref = useMapCamera(box, motion);
  return <svg ref={ref} viewBox={[box.x, box.y, box.width, box.height].join(' ')} />;
}
it('continues from the visible camera when interrupted and cancels motion immediately when disabled', () => {
  const start = { x: 190, y: 30, width: 40, height: 20 };
  const { container, rerender } = render(<Camera box={start} />);
  const svg = container.querySelector('svg')!;
  expect(callbacks.size).toBe(0);
  rerender(<Camera box={{ ...start, x: 220 }} />);
  expect(svg).toHaveAttribute('viewBox', '190 30 40 20');
  advance(0);
  advance(130);
  const halfway = svg.getAttribute('viewBox');
  expect(halfway).not.toBe('190 30 40 20');
  expect(halfway).not.toBe('220 30 40 20');
  rerender(<Camera box={{ ...start, x: 200 }} />);
  expect(svg).toHaveAttribute('viewBox', halfway);
  expect(callbacks.size).toBe(1);
  rerender(<Camera box={{ ...start, x: 200 }} motion={false} />);
  expect(callbacks.size).toBe(0);
  expect(svg).toHaveAttribute('viewBox', '200 30 40 20');
});
it('takes the short path across the date line and disposes the pending frame on unmount', () => {
  const { container, rerender, unmount } = render(
    <Camera box={{ x: 340, y: 60, width: 20, height: 10 }} />,
  );
  const svg = container.querySelector('svg')!;
  rerender(<Camera box={{ x: 0, y: 60, width: 20, height: 10 }} />);
  advance(0);
  advance(260);
  expect(svg).toHaveAttribute('viewBox', '360 60 20 10');
  rerender(<Camera box={{ x: 5, y: 60, width: 20, height: 10 }} />);
  expect(callbacks.size).toBe(1);
  unmount();
  expect(callbacks.size).toBe(0);
});
