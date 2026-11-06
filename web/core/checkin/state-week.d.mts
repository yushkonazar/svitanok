import type { AdaptiveDay } from './adaptive-observations.mjs';
export const STATE_SLEEP_REFERENCE: 420;
export type StateWeekKey = 'sleep' | 'mood' | 'energy' | 'plans';
export interface WeekEvidence {
  kind: 'reported' | 'observed';
  text: string;
  dates: string[];
  examples?: { date: string; text: string }[];
  idea?: string;
}
export interface WeekHighlight {
  key: StateWeekKey;
  title: string;
  text: string;
  samples: number;
  dates: string[];
  context: WeekEvidence[];
}
export interface WeekSignal extends WeekHighlight {
  priority: number;
  max: number;
  reference?: number;
  slot?: 'morning' | 'afternoon' | 'evening';
  points: { date: string; value: number | null; label: string }[];
}
export function stateWeek(days: AdaptiveDay[]): {
  signals: Record<StateWeekKey, WeekSignal>;
  focus: StateWeekKey;
  highlights: WeekHighlight[];
};
