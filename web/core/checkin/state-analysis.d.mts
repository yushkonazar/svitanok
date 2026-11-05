import type { AdaptiveDay } from './adaptive-observations.mjs';
import { analyzeAdaptive } from './adaptive-observations.mjs';
export type StatePoint = { date: string; value: number };
export interface StateDistribution {
  n: number;
  items: { id: string; label: string; count: number; dates: string[] }[];
}
export interface StateComparison {
  factor: string;
  outcome: string;
  title: string;
  outcomeLabel: string;
  groups: { label: string; n: number; value: number | null; dates: string[]; values: number[] }[];
  ready: boolean;
  delta: number | null;
  median: number | null;
  from: string | null;
  domain: number[];
}
export interface StateMetric {
  id: string;
  label: string;
  value: number | null;
  n: number;
  previous: number | null;
  previousN: number;
  delta: number | null;
  unit: string;
  slots: string[];
  points: StatePoint[];
}
export interface StateInsight {
  id: string;
  title: string;
  text: string;
  idea?: string;
  dates: string[];
  n: number;
  kind: string;
  comparison?: StateComparison;
}
export type StateReport = Omit<ReturnType<typeof analyzeAdaptive>, 'learning'> & {
  overview: StateMetric[];
  insights: StateInsight[];
  recovery: { id: string; label: string; n: number; better: number; dates: string[] }[];
  learning: Record<
    string,
    { known: number; done: number; dates: string[]; planned: number; observed: number; met: number }
  >;
  personal: { n: number; enough: number; dates: string[] };
  previousFrom: string;
  previousTo: string;
};
export function stateValue(record: Record<string, unknown>, stem: string): any;
export const STATE_FACTORS: [string, string][];
export function stateDistribution(
  days: AdaptiveDay[],
  slot: string,
  stem: string,
  revision?: number,
): StateDistribution;
export function stateOutcomes(factor: string, slot?: string): [string, string][];
export function stateCompanyOptions(days: AdaptiveDay[], slot?: string): StateDistribution['items'];
export function compareState(
  days: AdaptiveDay[],
  factor: string,
  outcome: string,
  options?: { slot?: string; company?: string },
): StateComparison;
export function stateReport(records: Record<string, any>, to: string, period?: number): StateReport;
export function demoStateRecords(to: string): Record<string, any>;
