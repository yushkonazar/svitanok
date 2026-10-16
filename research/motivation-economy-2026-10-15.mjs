// Design simulation. Synthetic scenarios, not a forecast of the owner's behaviour.
// Run: node research/motivation-economy-2026-10-15.mjs
import assert from 'node:assert/strict';

const fraction = (n) => Math.max(0, Math.min(1, n));
// Numerical tolerance avoids 50 * 0.58 becoming 28.999999999999996.
const xpFloor = (n) => Math.floor(n + 1e-9);
const xpCeil = (n) => Math.ceil(n - 1e-9);

export function settleDay(tasks, balance = 200) {
  const committedXp = tasks.filter((t) => t.committed).reduce((s, t) => s + t.xp, 0);
  const cap = Math.min(30, Math.ceil(0.3 * committedXp));
  let earned = 0;
  let requestedLoss = 0;
  for (const task of tasks) {
    const onTime = fraction(task.onTime ?? 0);
    const late = Math.min(1 - onTime, fraction(task.late ?? 0));
    earned += xpFloor(task.xp * (onTime + 0.5 * late));
    if (task.committed) requestedLoss += xpCeil(xpCeil(0.3 * task.xp) * (1 - onTime));
  }
  const loss = Math.min(requestedLoss, cap, balance + earned);
  return { earned, loss, cap, net: earned - loss, balance: balance + earned - loss };
}

const task = (xp, committed, onTime, late = 0) => ({ xp, committed, onTime, late });
const full = [task(35, true, 1), task(35, true, 1), task(20, true, 1), task(10, false, 1)];
const mixed = [task(35, true, 1), task(35, true, 0.5), task(20, true, 0), task(10, false, 1)];
const difficult = [task(35, true, 0.5), task(35, true, 0), task(20, true, 0), task(10, false, 1)];
const missed = full.map((t) => ({ ...t, onTime: 0 }));
const overload = Array.from({ length: 8 }, () => task(50, true, 0));

const scenarios = { full, mixed, difficult, missed, overload, rest: [] };
const dayResults = Object.fromEntries(
  Object.entries(scenarios).map(([name, tasks]) => [name, settleDay(tasks)]),
);

function runPeriod(names, openingBalance, repeat = 1) {
  let balance = openingBalance;
  let earned = 0;
  let loss = 0;
  for (let r = 0; r < repeat; r++) {
    for (const name of names) {
      const day = settleDay(scenarios[name], balance);
      earned += day.earned;
      loss += day.loss;
      balance = day.balance;
    }
  }
  return {
    days: names.length * repeat,
    openingBalance,
    earned,
    loss,
    net: earned - loss,
    closingBalance: balance,
  };
}

const illustrativeWeek = ['full', 'mixed', 'full', 'difficult', 'mixed', 'full', 'rest'];
const week = runPeriod(illustrativeWeek, 200);
const fourWeeks = runPeriod(illustrativeWeek, 200, 4);
// Stress case with fourteen explicitly confirmed plans. Unconfirmed recurring
// drafts must not create these losses in the proposed product.
const confirmedMissedPlans = runPeriod(Array(14).fill('missed'), 200);

// Check the arithmetic at boundaries, not whether this design changes behaviour.
for (const xp of [10, 20, 35, 50]) {
  for (let n = 0; n <= 100; n++) {
    const onTime = n / 100;
    for (const late of [0, 1 - onTime]) {
      const day = settleDay([task(xp, true, onTime, late)], 100);
      assert(day.earned >= 0 && day.earned <= xp);
      assert(day.loss >= 0 && day.loss <= day.cap && day.cap <= 30);
      assert(day.balance >= 0);
    }
  }
}
assert.equal(dayResults.full.net, 100);
assert.equal(dayResults.mixed.net, 50);
assert.equal(dayResults.difficult.net, 4);
assert.equal(dayResults.overload.loss, 30);
assert.equal(settleDay([], 200).loss, 0);
assert.equal(settleDay(missed, 0).loss, 0);
assert.equal(confirmedMissedPlans.closingBalance, 0);
assert.equal(week.net, 404);
assert.equal(fourWeeks.net, 1616);

// A single outcome's maximum XP must be shared by its subtasks.
const parentBudget = 35;
const naiveFiveTasks = 5 * 20;
const correctlySharedParts = [7, 7, 7, 7, 7].reduce((a, b) => a + b, 0);
assert.equal(correctlySharedParts, parentBudget);

console.log(
  JSON.stringify(
    {
      notice:
        'Synthetic design simulation. No measured personal effect, no reward spending in period totals.',
      dayResults,
      week,
      fourWeeks,
      confirmedMissedPlans,
      splitting: { parentBudget, naiveFiveTasks, correctlySharedParts },
      rewardHorizonsAtNet50To70PerActiveDay: Object.fromEntries(
        [80, 250, 800].map((price) => [
          price,
          {
            fastestActiveDays: Math.ceil(price / 70),
            slowestActiveDays: Math.ceil(price / 50),
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
