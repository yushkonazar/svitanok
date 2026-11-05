export interface StateArchiveMetric {
  n: number;
  counts: Record<string, number>;
  sum: number;
  numericN: number;
  average: number | null;
  label?: string;
  labels?: Record<string, string>;
  labelCounts?: Record<string, Record<string, number>>;
}
export interface StateArchiveMonth {
  month: string;
  observationsV3?: {
    metrics: Record<string, StateArchiveMetric>;
    days?: number;
    confirmedSlots?: number;
    from?: string;
    to?: string;
  };
}
export function appendStateArchive(
  target: Record<string, any>,
  date: string,
  record: Record<string, any>,
): void;
export function stateHistoryMonths(
  months: StateArchiveMonth[],
  records: Record<string, any>,
  from: string,
  to: string,
): StateArchiveMonth[];
export function stateHistorySeries(
  months: StateArchiveMonth[],
  id: string,
  to: string,
  range?: 'all' | 'year',
): {
  series: { month: string; date: string; value: number | null; n: number }[];
  value: number | null;
  n: number;
  from: string | null;
  to: string | null;
};
