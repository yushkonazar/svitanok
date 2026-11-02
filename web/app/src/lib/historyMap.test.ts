import { expect, it } from 'vitest';
import { fitHistoryMap, mapLongitude, zoomHistoryMap } from './historyMap.ts';
it('fits Europe tightly and includes every marker with padding', () => {
  const points = [
    { lat: 49.84, lon: 24.03 },
    { lat: 50.45, lon: 30.52 },
    { lat: 48.86, lon: 2.35 },
  ];
  const box = fitHistoryMap(points);
  expect(box.width).toBeLessThan(100);
  for (const p of points) {
    expect(mapLongitude(p.lon, box)).toBeGreaterThan(box.x);
    expect(mapLongitude(p.lon, box)).toBeLessThan(box.x + box.width);
    expect(90 - p.lat).toBeGreaterThan(box.y);
    expect(90 - p.lat).toBeLessThan(box.y + box.height);
  }
});
it('uses the short date-line arc and can zoom out to the world', () => {
  const box = fitHistoryMap([
    { lat: 20, lon: 179 },
    { lat: 22, lon: -179 },
  ]);
  expect(box.width).toBe(40);
  expect(Math.abs(mapLongitude(179, box) - mapLongitude(-179, box))).toBe(2);
  expect(zoomHistoryMap(box, box.width / 360).width).toBe(360);
});
it('keeps broad global events global and handles absent coordinates', () => {
  expect(fitHistoryMap([]).width).toBe(360);
  expect(
    fitHistoryMap([
      { lat: 65, lon: -130 },
      { lat: -35, lon: 150 },
      { lat: 50, lon: 10 },
    ]).width,
  ).toBe(360);
});
