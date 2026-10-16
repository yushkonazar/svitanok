export interface TaxiPolicy {
  id: string;
  effectiveAt: string;
  fareBps: number;
  commissionBps: number;
  fuelBps: number;
  tipsBps?: number;
  thresholdMinor: number | null;
  bonusFareBps: number;
  periodStart?: boolean;
  weekDay?: number;
  weekHour?: number;
  weekMinute?: number;
  vehicleName?: string;
}
export interface TaxiEntry {
  id: string;
  at: string;
  policyId: string;
  periodKey?: string | null;
  netCashMinor: number;
  commissionMinor: number;
  fuelMinor: number;
  tipsMinor: number;
  directMinor: number;
  receivedCashMinor?: number;
  paidWorkMinor?: number;
  commissionReported?: boolean;
  cashReported?: boolean;
  note?: string;
}
export const MAX_MINOR: number;
export function minor(value: unknown, signed?: boolean): number;
export function parseMoney(raw: string, signed?: boolean): number;
export function share(amount: number, bps: number): number;
export function sumMoney(amounts: number[]): number;
export function kyivParts(ms: number): { date: string; hour: number; minute: number };
export function shiftDate(date: string, days: number): string;
export function kyivInstant(date: string, hour?: number, minute?: number): number;
export function taxiWeek(
  ms: number,
  policies?: TaxiPolicy[],
): { key: string; from: number; to: number };
export function taxiPeriodStart(key: string, policies?: TaxiPolicy[]): number;
export function taxiEntryWeek(
  entry: TaxiEntry,
  policies?: TaxiPolicy[],
): { key: string; from: number; to: number };
export function prepareTaxiTransition(
  entries: TaxiEntry[],
  policies: TaxiPolicy[],
  settlements: { weekKey: string }[],
  policy: TaxiPolicy,
  keepPreviousEntryIds: unknown,
): {
  policy: TaxiPolicy;
  previous: { key: string; from: number; to: number };
  next: { key: string; from: number; to: number };
  updates: { id: string; policyId: string; periodKey: string | null }[];
};
export function validatePolicy(policy: TaxiPolicy): TaxiPolicy;
export function calculateTaxiWeek(
  entries: TaxiEntry[],
  policies: TaxiPolicy[],
  nowMs: number,
): {
  key: string;
  from: number;
  to: number;
  grossMinor: number;
  netCashMinor: number;
  earnedMinor: number;
  entries: TaxiEntry[];
  groups: {
    policyId: string;
    grossMinor: number;
    commissionMinor: number;
    fuelMinor: number;
    extrasMinor: number;
    fareBps: number;
    boosted: boolean;
    earnedMinor: number;
  }[];
};
export function nextPaymentDate(
  nextDate: string,
  anchorDay: number,
  period: 'day' | 'week' | 'month' | 'year',
): string;
