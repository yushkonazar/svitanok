import { toKyivInput } from '../../api/leisure.ts';

/** Leave half an hour to get ready, and a useful evening window even when opened late. */
export function defaultTogetherWindow(nowMs = Date.now()) {
  const local = toKyivInput(new Date(nowMs).toISOString());
  const today = local.slice(0, 10);
  const minutes = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const start = Math.max(17 * 60 + 30, Math.ceil((minutes + 30) / 30) * 30);
  const tomorrow = start > 20 * 60 + 30;
  const date = tomorrow
    ? new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)
    : today;
  const time = tomorrow ? 17 * 60 + 30 : start;
  return {
    from: date,
    to: date,
    startTime: `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`,
    endTime: '22:00',
  };
}
