export type LeisureWindow = {
  from: string;
  to: string;
  startTime: string;
  endTime: string;
  transport: 'car' | 'walk' | 'transit';
  budgetMinor: number | null;
  pace: 'relaxed' | 'balanced';
  allowNew: boolean;
  includeFamiliar: boolean;
  startLocation: string;
  days: Array<{ date: string; startAt: number; endAt: number }>;
};
export function normalizeLeisureWindow(input: unknown, nowMs: number): LeisureWindow;
