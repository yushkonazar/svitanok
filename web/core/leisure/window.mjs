import { leisureLocalInstant } from './schedule.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
const MINUTE = 60000,
  DAY = 86400000;

/** @param {any} input @param {number} nowMs */
export function normalizeLeisureWindow(input, nowMs) {
  if (!input || typeof input !== 'object') throw new Error('Обери дату й час для виходу.');
  const from = String(input.from ?? input.date ?? ''),
    to = String(input.to ?? from);
  const startTime = String(input.startTime ?? '17:30'),
    endTime = String(input.endTime ?? '22:00');
  const start = leisureLocalInstant(from, startTime),
    end = leisureLocalInstant(to, endTime);
  const count = Math.round((Date.parse(to + 'T12:00Z') - Date.parse(from + 'T12:00Z')) / DAY) + 1;
  if (count < 1 || count > 14) throw new Error('Обери від одного до 14 днів.');
  if (from < kyivDateKey(new Date(nowMs)))
    throw new Error('Для виходу обери сьогодні або майбутній день.');
  if (!['walk', 'car', 'transit'].includes(input.transport ?? 'car'))
    throw new Error('Обери спосіб пересування.');
  const budgetMinor =
    input.budgetMinor == null || input.budgetMinor === '' ? null : Number(input.budgetMinor);
  if (
    budgetMinor != null &&
    (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0 || budgetMinor > 100000000)
  )
    throw new Error('Перевір бюджет на двох.');
  const days = [];
  for (let date = from; date <= to; date = addDaysToDateKey(date, 1)) {
    const perDay = input.perDay?.[date] ?? {},
      a = leisureLocalInstant(date, perDay.startTime ?? startTime),
      b = leisureLocalInstant(date, perDay.endTime ?? endTime);
    if (b <= a) throw new Error('Завершення має бути пізніше початку в межах дня.');
    if (b - a > 16 * 60 * MINUTE) throw new Error('Обери до 16 годин для одного виходу.');
    days.push({ date, startAt: a, endAt: b });
  }
  if (!days.some((d) => d.endAt > nowMs) || start > end)
    throw new Error('Обери майбутній проміжок.');
  return {
    from,
    to,
    startTime,
    endTime,
    transport: input.transport ?? 'car',
    budgetMinor,
    pace: input.pace === 'relaxed' ? 'relaxed' : 'balanced',
    allowNew: input.allowNew === true,
    includeFamiliar: input.includeFamiliar === true,
    startLocation: String(input.startLocation ?? '')
      .trim()
      .slice(0, 200),
    days,
  };
}
