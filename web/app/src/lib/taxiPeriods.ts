import { taxiPeriodStart, taxiWeek, type TaxiPolicy } from '../../../core/finance/planning.mjs';

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
