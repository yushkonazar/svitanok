import {
  taxiPeriodStart,
  taxiWeek,
  type TaxiPlanDay,
  type TaxiPolicy,
} from '../../../core/finance/planning.mjs';

const taxiDate = new Intl.DateTimeFormat('uk-UA', {
  weekday: 'short',
  day: 'numeric',
  month: 'numeric',
  timeZone: 'Europe/Kyiv',
});
const taxiTime = new Intl.DateTimeFormat('uk-UA', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Kyiv',
});
export function taxiDayTime(day: TaxiPlanDay) {
  if (day.handover) return `до ${taxiTime.format(day.to)}`;
  return day.units < 1 ? `від ${taxiTime.format(day.from)}` : '';
}
export function taxiDayLabel(day: TaxiPlanDay) {
  const time = taxiDayTime(day);
  return [taxiDate.format(day.from), time].filter(Boolean).join(' · ');
}

export function taxiPeriodLabel(key: string, policies: TaxiPolicy[]) {
  const period = taxiWeek(taxiPeriodStart(key, policies), policies);
  return taxiRangeLabel(period.from, period.to);
}
export function taxiRangeLabel(from: number, to: number) {
  const format = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${format.format(from)} — ${format.format(to)}`;
}
export function taxiVehicleName(at: number, policies: TaxiPolicy[]) {
  return (
    policies.filter((p) => p.periodStart && Date.parse(p.effectiveAt) <= at).at(-1)?.vehicleName ??
    'Попереднє авто'
  );
}
export function taxiScheduleLabel(at: number, policies: TaxiPolicy[]) {
  const policy = policies.filter((p) => p.periodStart && Date.parse(p.effectiveAt) <= at).at(-1);
  const days = [
    'Щопонеділка',
    'Щовівторка',
    'Щосереди',
    'Щочетверга',
    'Щоп’ятниці',
    'Щосуботи',
    'Щонеділі',
  ];
  return `${days[policy?.weekDay ?? 0]} о ${String(policy?.weekHour ?? 13).padStart(2, '0')}:${String(policy?.weekMinute ?? 0).padStart(2, '0')}, Київ`;
}
