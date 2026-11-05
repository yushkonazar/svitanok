export const stateNumber = (value: number | null, digits = 1) =>
  value == null ? '—' : value.toLocaleString('uk-UA', { maximumFractionDigits: digits });
export function stateSleep(value: number | null) {
  if (value == null) return '—';
  return `${value > 0 ? '≈ ' : ''}${stateDuration(value, 5)}`;
}
export function stateDuration(hours: number, precision = 1) {
  const minutes = Math.round((hours * 60) / precision) * precision;
  return `${Math.floor(minutes / 60)} год${minutes % 60 ? ` ${minutes % 60} хв` : ''}`;
}
export const stateDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
export const stateMonth = (date: string) =>
  new Date(`${date.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString('uk-UA', {
    month: 'short',
    year: 'numeric',
  });
export const slotNames = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
export function stateCount(n: number, one: string, few: string, many: string) {
  const tail = n % 100,
    word =
      tail >= 11 && tail <= 14
        ? many
        : n % 10 === 1
          ? one
          : n % 10 >= 2 && n % 10 <= 4
            ? few
            : many;
  return `${n} ${word}`;
}
export const stateDays = (n: number) => stateCount(n, 'день', 'дні', 'днів');
export function statePoints(value: number, signed = false) {
  const absolute = Math.round(Math.abs(value) * 100) / 100;
  const prefix = absolute === 0 ? '' : value < 0 ? '−' : signed ? '+' : '';
  return (
    prefix +
    (Number.isInteger(absolute)
      ? stateCount(absolute, 'бал', 'бали', 'балів')
      : `${stateNumber(absolute, 2)} бала`)
  );
}
