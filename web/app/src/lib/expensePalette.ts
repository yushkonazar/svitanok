import { financeDisplay } from '../../../core/finance/display.mjs';
// OKLCH keeps ordered red tones perceptually spaced as the user changes bin count.
export function expensePalette(count: number) {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const t = count <= 1 ? 0.5 : i / (count - 1);
    return {
      dark: `oklch(${0.88 - 0.16 * t} ${0.055 + 0.13 * t} ${48 - 23 * t})`,
      light: `oklch(${0.49 - 0.1 * t} ${0.1 + 0.055 * t} ${48 - 23 * t})`,
    };
  });
}
export function expenseBand(amountMinor: number, thresholds = financeDisplay().expenseThresholds) {
  const index = thresholds.findIndex((t) => Math.abs(amountMinor) <= t);
  const rank = index < 0 ? thresholds.length : index;
  const palette = expensePalette(thresholds.length + 1);
  return {
    rank,
    ...palette[rank],
    label:
      thresholds.length === 0
        ? 'Усі витрати'
        : rank === 0
          ? `До ${(thresholds[0] / 100).toLocaleString('uk-UA')} ₴`
          : rank === thresholds.length
            ? `Понад ${(thresholds.at(-1)! / 100).toLocaleString('uk-UA')} ₴`
            : `Понад ${(thresholds[rank - 1] / 100).toLocaleString('uk-UA')} до ${(thresholds[rank] / 100).toLocaleString('uk-UA')} ₴`,
  };
}
