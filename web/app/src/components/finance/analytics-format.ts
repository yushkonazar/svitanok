export const financeDate = (date: string) =>
  new Date(date.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
export const financeRange = (from: string, to: string) =>
  `${financeDate(from)} — ${financeDate(to)}`;
