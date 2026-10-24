import { financeDisplay } from '../../../core/finance/display.mjs';
// OKLCH keeps ordered red tones perceptually spaced as the user changes bin count.
export function expensePalette(count: number) {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const t = count <= 1 ? 0.5 : i / (count - 1);
    return {
      dark: `oklch(${0.86 - 0.14 * t} ${0.055 + 0.13 * t} 25)`,
      light: `oklch(${0.49 - 0.1 * t} ${0.12 + 0.035 * t} 25)`,
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
          ? 'Невелика витрата'
          : rank === thresholds.length
            ? 'Найбільший діапазон витрат'
            : `Витрата · діапазон ${rank + 1}`,
  };
}
