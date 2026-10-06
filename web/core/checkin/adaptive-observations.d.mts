export interface AdaptiveDay {
  date: string;
  morning: Record<string, any>;
  afternoon: Record<string, any>;
  evening: Record<string, any>;
  sleepHours: number | null;
  sleepQuality: number | null;
  satisfaction: number | null;
}
export function adaptiveDay(date: string, raw: Record<string, any>): AdaptiveDay;
export function frequenciesV3(
  days: AdaptiveDay[],
  slot: string,
  key: string,
): { n: number; counts: Record<string, number> };
export function pointsV3(
  days: AdaptiveDay[],
  slot: string,
  key: string,
): { date: string; value: number }[];
export function analyzeAdaptive(
  records: Record<string, any>,
  to: string,
  days?: number,
): {
  from: string;
  to: string;
  days: number;
  current: AdaptiveDay[];
  previous: AdaptiveDay[];
  recordedDays: number;
  state: Record<
    string,
    { energy: { n: number; value: number | null }; mood: { n: number; value: number | null } }
  >;
  sleep: { n: number; value: number | null };
  sleepQuality: { n: number; value: number | null };
  satisfaction: { n: number; value: number | null };
  priorSleep: { n: number; value: number | null };
  priorSatisfaction: { n: number; value: number | null };
  confirmedSlots: number;
  lowerEnergy: number;
  energyPairs: number;
  learning: number;
  reading: number;
  developmentAnswers: number;
  planned: number;
  followThrough: number;
  met: number;
  poorSleep: number;
  goodSleep: number;
};
export function adaptiveMetrics(days: AdaptiveDay[]): Record<string, any>;
export function demoAdaptive(to: string): Record<string, any>;
