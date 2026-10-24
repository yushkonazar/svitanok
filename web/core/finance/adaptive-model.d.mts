export const MODEL_VERSION: string;
export function quantile(xs: number[], p?: number): number;
export function filterLocalLevel(
  values: (number | null)[],
  q: number,
  r: number,
  effects?: number[],
  offset?: number,
): { level: number; variance: number; loss: number; residuals: number[] };
export interface AdaptiveModel {
  model: string;
  version: string;
  count: number;
  scores: { name: string; folds: number; mae: number | null }[];
  points: number[];
  residuals: number[];
  noise: number;
  status: string;
}
export function adaptiveForecast(
  values: (number | null)[],
  days: number,
  offset?: number,
): AdaptiveModel;
