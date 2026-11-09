import { financeDisplay } from '../../../core/finance/display.mjs';
// Hue and lightness both change, including in a dense set of custom ranges.
export function expensePalette(count: number, direction: 'out' | 'in' = 'out') {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const t = count <= 1 ? 0.5 : i / (count - 1);
    return direction === 'in'
      ? {
          dark: `oklch(${0.75 + 0.15 * t} ${0.055 + 0.105 * t} ${204 - 52 * t})`,
          light: `oklch(${0.49 - 0.105 * t} ${0.075 + 0.045 * t} ${204 - 52 * t})`,
        }
      : {
          dark: `oklch(${0.9 - 0.17 * t} ${0.08 + 0.095 * t} ${79 - 105 * t})`,
          light: `oklch(${0.49 - 0.1 * t} ${0.1 + 0.055 * t} ${79 - 105 * t})`,
        };
  });
}
export function expenseBand(amountMinor: number, thresholds = financeDisplay().expenseThresholds) {
  return amountBand(amountMinor, thresholds, 'out');
}

export function amountBand(amountMinor: number, thresholds: number[], direction: 'out' | 'in') {
  const index = thresholds.findIndex((t) => Math.abs(amountMinor) <= t);
  const rank = index < 0 ? thresholds.length : index;
  const palette = expensePalette(thresholds.length + 1, direction);
  return {
    rank,
    ...palette[rank],
    label:
      thresholds.length === 0
        ? direction === 'in'
          ? 'Усі надходження'
          : 'Усі списання'
        : rank === 0
          ? `До ${(thresholds[0] / 100).toLocaleString('uk-UA')} ₴`
          : rank === thresholds.length
            ? `Понад ${(thresholds.at(-1)! / 100).toLocaleString('uk-UA')} ₴`
            : `Понад ${(thresholds[rank - 1] / 100).toLocaleString('uk-UA')} до ${(thresholds[rank] / 100).toLocaleString('uk-UA')} ₴`,
  };
}
