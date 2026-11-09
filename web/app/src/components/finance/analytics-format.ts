export const financeDate = (date: string) =>
  new Date(date.slice(0, 10) + 'T12:00:00Z')
    .toLocaleDateString('uk-UA', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
    .replace(/ р\.$/, '');
export const financeRange = (from: string, to: string) =>
  `${financeDate(from)} — ${financeDate(to)}`;

/** Calendar keys are civil dates, not UTC instants. */
export const financeDay = (date: string) =>
  new Date(date.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });
export const financeMonth = (date: string) =>
  new Date(date.slice(0, 7) + '-01T12:00:00Z').toLocaleDateString('uk-UA', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
export const financeTime = (date: string) =>
  new Date(date).toLocaleString('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Kyiv',
  });
export function plural(count: number, one: string, few: string, many: string) {
  const n = Math.abs(Math.trunc(count));
  return n % 100 >= 11 && n % 100 <= 14
    ? many
    : n % 10 === 1
      ? one
      : n % 10 >= 2 && n % 10 <= 4
        ? few
        : many;
}
export const counted = (n: number, one: string, few: string, many: string) =>
  `${n.toLocaleString('uk-UA')} ${plural(n, one, few, many)}`;
export const paymentsCount = (n: number) => counted(n, 'оплата', 'оплати', 'оплат');
export const daysCount = (n: number) => counted(n, 'день', 'дні', 'днів');
export const percentLabel = (n: number) =>
  `${n.toLocaleString('uk-UA', { maximumFractionDigits: 1 })}%`;
export const amountNumber = (minor: number) =>
  ((minor === 0 ? 0 : minor) / 100).toLocaleString('uk-UA', {
    minimumFractionDigits: minor % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
export const compactAmount = (minor: number, maximumSignificantDigits?: number) =>
  ((minor === 0 ? 0 : minor) / 100).toLocaleString('uk-UA', {
    notation: 'compact',
    maximumFractionDigits: 1,
    maximumSignificantDigits,
  });

export const financeMonthShort = (date: string) => {
  const parts = new Intl.DateTimeFormat('uk-UA', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }).formatToParts(new Date(date.slice(0, 7) + '-01T12:00:00Z'));
  return `${parts.find((p) => p.type === 'month')?.value} ${parts.find((p) => p.type === 'year')?.value}`;
};
