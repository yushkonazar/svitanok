import { median } from 'd3-array';
import type { AdaptiveDay } from '../../../../core/checkin/adaptive-observations.mjs';
import { stateOutcomeValue } from '../../../../core/checkin/state-analysis.mjs';
import { observedMean } from '../../../../core/checkin/observations.mjs';
import type { CheckinSlot } from '../../api/schema.ts';
import { stateDuration, statePoints } from './state-format.ts';

export const stateSlots = ['morning', 'afternoon', 'evening'] as const;
export const stateSlotColors = ['var(--color-a2)', 'var(--color-info)', 'var(--color-pos)'];
export type StateSlotFilter = CheckinSlot | 'all';
export type StateMetricKey = 'energy' | 'mood' | 'sleep' | 'satisfaction' | 'change';
export type RatedMetric = Exclude<StateMetricKey, 'sleep'>;
export const stateMetricNames: Record<StateMetricKey, string> = {
  energy: 'Енергія',
  mood: 'Настрій',
  sleep: 'Основний сон',
  satisfaction: 'Оцінка дня',
  change: 'Зміна енергії за день',
};
export const stateBandNames: Record<RatedMetric, [string, string, string]> = {
  energy: ['Мало сил', 'Помірно сил', 'Багато сил'],
  mood: ['Складний', 'Змішаний', 'Хороший'],
  satisfaction: ['Важко', 'Змішано', 'Добре'],
  change: ['Спад', 'Без змін', 'Підйом'],
};

export function stateBand(value: number, metric: RatedMetric) {
  if (metric === 'change') return value < 0 ? 0 : value > 0 ? 2 : 1;
  return value < 2.5 ? 0 : value >= 3.5 ? 2 : 1;
}
export function stateBands(values: (number | null)[], metric: RatedMetric) {
  const counts: [number, number, number] = [0, 0, 0];
  for (const value of values) if (value != null) counts[stateBand(value, metric)]++;
  return counts;
}
export const stateHasSlots = (metric: StateMetricKey) => metric === 'energy' || metric === 'mood';
export function stateSeries(
  days: AdaptiveDay[],
  metric: StateMetricKey,
  slot: CheckinSlot = 'evening',
) {
  const key =
    metric === 'change' ? 'energy_change' : stateHasSlots(metric) ? `${slot}_${metric}` : metric;
  return days.map((day) => stateOutcomeValue(day, key));
}
export const stateValues = (series: (number | null)[]) => series.filter((value) => value != null);
export function stateRollup(series: (number | null)[], metric: StateMetricKey) {
  return metric === 'sleep' ? (median(stateValues(series)) ?? null) : observedMean(series).value;
}
export function stateBuckets(series: (number | null)[], metric: StateMetricKey, weekly: boolean) {
  const buckets: { start: number; end: number; value: number | null }[] = [];
  const step = weekly ? 7 : 1;
  for (let start = 0; start < series.length;) {
    const end = start + (start === 0 ? series.length % step || step : step);
    buckets.push({
      start,
      end,
      value: weekly ? stateRollup(series.slice(start, end), metric) : (series[start] ?? null),
    });
    start = end;
  }
  return buckets;
}
export function stateExact(metric: StateMetricKey, value: number) {
  return metric === 'sleep' ? stateDuration(value) : statePoints(value, metric === 'change');
}
