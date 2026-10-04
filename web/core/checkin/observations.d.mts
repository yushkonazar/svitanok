export interface ObservationDay {
  date: string;
  morning: Record<string, any>;
  afternoon: Record<string, any>;
  evening: Record<string, any>;
  sleepHours: number | null;
  sleepApprox: boolean;
  napMinutes: number | null;
  napOverlap: boolean;
  sleepQuality: number | null;
  satisfaction: number | null;
  learningMinutes: number | null;
}
export interface Mean {
  n: number;
  value: number | null;
}
export function shiftCheckinDate(date: string, n: number): string;
export function observedMean(values: (number | null)[]): Mean;
export function observationDay(date: string, raw: Record<string, unknown>): ObservationDay;
export function observationPoints(
  days: ObservationDay[],
  slot: string,
  metric: string,
): { date: string; value: number }[];
export function compareObservedFactor(
  days: ObservationDay[],
  field: string,
  value: string | number,
  metric?: string,
): { withFactor: Mean; withoutFactor: Mean; eligible: boolean; difference: number | null };
export function clockRegularity(
  days: ObservationDay[],
  key: string,
): { n: number; spreadMinutes: number | null };
export function analyzeObservations(
  records: Record<string, unknown>,
  to: string,
  days?: number,
): {
  from: string;
  to: string;
  days: number;
  current: ObservationDay[];
  previous: ObservationDay[];
  previousFrom: string;
  previousTo: string;
  recordedDays: number;
  facts: {
    lowerEnergy: number;
    energyPairs: number;
    learningDays: number;
    learningMinutes: number;
    confirmedSlots: number;
  };
  outcomes: Record<string, number>;
  activities: Record<string, number>;
  activityGroups: Record<string, number>;
  sleep: Mean;
  sleepQuality: Mean;
  sleepRegularity: { n: number; spreadMinutes: number | null };
  wakeRegularity: { n: number; spreadMinutes: number | null };
};
export function demoObservations(to: string): Record<string, any>;
