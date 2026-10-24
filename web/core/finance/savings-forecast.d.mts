export interface SavingsForecast {
  id: string;
  name: string;
  amount: number;
  events: { date: string; amount: number; planned: number; earliest: string; latest: string }[];
  earlyEvents: { date: string; amount: number }[];
  target: number;
  period: string;
  gap: number;
  pace: number;
  adaptive: boolean;
  remaining: number;
  deadline: string | null;
  description: string;
}
export function savingsForecast(finance: any, days: number, nowMs: number): SavingsForecast[];
