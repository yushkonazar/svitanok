import { kyivParts, shiftDate, sumMoney } from './planning.mjs';
/** @param {string} date @param {string} period */
function cycleStart(date, period) {
  if (period === 'day') return date;
  if (period === 'month') return date.slice(0, 7) + '-01';
  return shiftDate(date, -((new Date(date + 'T12:00Z').getUTCDay() + 6) % 7));
}
/** Flexible goal contributions, not enforceable bills. Past gaps remain separate from expected cash.
 * @param {any} finance @param {number} days @param {number} nowMs */
export function savingsForecast(finance, days, nowMs) {
  const today = kyivParts(nowMs).date,
    until = shiftDate(today, days - 1);
  return (finance.goals ?? [])
    .filter(
      (/** @type {any} */ g) => g.status === 'active' && g.planAmountMinor > 0 && g.planPeriod,
    )
    .map((/** @type {any} */ g) => {
      const moves = finance.goalMoves.filter(
        (/** @type {any} */ m) => m.goalId === g.id && Date.parse(m.at) <= nowMs,
      );
      const total = sumMoney(moves.map((/** @type {any} */ m) => m.amountMinor));
      const remaining = Math.max(0, g.targetMinor - total),
        target = g.planAmountMinor,
        period = g.planPeriod;
      const start = cycleStart(today, period);
      const planMoves = moves.filter(
        (/** @type {any} */ m) =>
          !g.planStartedAt || Date.parse(m.at) >= Date.parse(g.planStartedAt),
      );
      const first = g.planStartedAt
        ? cycleStart(kyivParts(Date.parse(g.planStartedAt)).date, period)
        : planMoves.length
          ? cycleStart(
              kyivParts(Date.parse(moves.map((/** @type {any} */ m) => m.at).sort()[0])).date,
              period,
            )
          : start;
      /** @type {Map<string,number>} */ const cycles = new Map();
      for (const m of planMoves) {
        const key = cycleStart(kyivParts(Date.parse(m.at)).date, period);
        cycles.set(key, (cycles.get(key) ?? 0) + m.amountMinor);
      }
      const completed = [];
      let cursor = first;
      for (let n = 0; n < 520 && cursor < start; n++) {
        completed.push(cycles.get(cursor) ?? 0);
        cursor =
          period === 'day'
            ? shiftDate(cursor, 1)
            : period === 'week'
              ? shiftDate(cursor, 7)
              : shiftDate(cursor, 32).slice(0, 7) + '-01';
      }
      const gap = Math.max(0, completed.length * target - completed.reduce((a, b) => a + b, 0));
      const recent = completed.slice(-6),
        partial = recent.filter((v) => v < target).length;
      let pace = 1;
      if (partial >= 2) {
        pace =
          recent.reduce((n, v, i) => n + Math.min(1.5, v / target) * (i + 1), 0) /
          recent.reduce((n, _, i) => n + i + 1, 0);
        pace = Math.max(0.1, Math.min(1.5, pace));
      }
      const weekday = finance.display?.savingWeekday ?? 2;
      /** @type {{date:string;amount:number;planned:number;earliest:string;latest:string}[]} */ const events =
        [];
      /** @type {{date:string;amount:number}[]} */ const earlyEvents = [];
      let available = remaining,
        cycle = start;
      for (let i = 0; i < 400 && cycle <= until && available > 0; i++) {
        const paid = cycle === start ? Math.max(0, cycles.get(start) ?? 0) : 0;
        const expectedDate =
          period === 'day'
            ? cycle
            : period === 'week'
              ? shiftDate(cycle, weekday)
              : cycle.slice(0, 7) + '-15';
        const end =
          period === 'day'
            ? cycle
            : period === 'week'
              ? shiftDate(cycle, 6)
              : shiftDate(shiftDate(cycle, 32).slice(0, 7) + '-01', -1);
        const planned = Math.max(0, target + (i === 0 ? gap : 0) - paid);
        // A first missed/partial cycle carries forward; repeated partial cycles learn actual pace.
        const expected = partial >= 2 ? Math.max(0, Math.round(target * pace) - paid) : planned;
        const date = expectedDate < today ? today : expectedDate;
        const amount = Math.min(available, expected);
        if (amount) earlyEvents.push({ date: cycle < today ? today : cycle, amount });
        if (amount && date <= until) {
          events.push({
            date,
            amount,
            planned: Math.min(available, planned),
            earliest: cycle < today ? today : cycle,
            latest: end,
          });
          available -= amount;
        }
        cycle =
          period === 'day'
            ? shiftDate(cycle, 1)
            : period === 'week'
              ? shiftDate(cycle, 7)
              : shiftDate(cycle, 32).slice(0, 7) + '-01';
      }
      return {
        id: g.id,
        name: g.name,
        amount: sumMoney(events.map((e) => e.amount)),
        events,
        earlyEvents,
        target,
        period,
        gap,
        pace: Math.round(pace * 100),
        adaptive: partial >= 2,
        remaining,
        deadline: g.deadline,
        description:
          partial >= 2
            ? 'Очікуваний темп адаптовано до повторних часткових внесків. Обраний план не змінено.'
            : 'Орієнтовний час внеску, без дедлайнів і прострочення.',
      };
    });
}
