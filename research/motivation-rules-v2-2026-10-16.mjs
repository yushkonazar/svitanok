// Executable design model, not a production service or behavioural experiment.
// node research/motivation-rules-v2-2026-10-16.mjs
import assert from 'node:assert/strict';

export function scoreTask(effort, contribution) {
  assert(Number.isInteger(effort) && effort >= 0 && effort <= 2);
  assert(contribution === 0 || contribution === 1);
  return [
    [10, 20],
    [20, 35],
    [35, 50],
  ][effort][contribution];
}

export function createModel(openingBalance, inputs) {
  const tasks = new Map(
    inputs.map((t) => [t.id, { ...t, units: 0, onTimeUnits: 0, credited: 0, penalty: null }]),
  );
  const operations = new Set();
  const events = [];
  let balance = openingBalance;
  let experience = 0;
  const fullPenalty = (t) => Math.ceil((t.xp * 30) / 100);
  const penaltyFor = (t, units) => Math.ceil((fullPenalty(t) * (t.target - units)) / t.target);
  const record = (kind, delta, id) => events.push({ kind, delta, id, balance });
  const once = (id, fn) => {
    if (operations.has(id)) return false;
    fn();
    operations.add(id);
    return true;
  };
  const reserve = () =>
    Math.min(
      balance,
      [...tasks.values()].reduce(
        (sum, t) => sum + (t.penalty ? 0 : penaltyFor(t, t.onTimeUnits)),
        0,
      ),
    );
  return {
    report(id, rawUnits, beforeDeadline, operationId) {
      return once(operationId, () => {
        const t = tasks.get(id);
        assert(t, 'unknown task');
        assert(Number.isSafeInteger(rawUnits), 'whole units required');
        const observedUnits = Math.max(0, Math.min(t.target, rawUnits));
        const units = Math.max(t.units, observedUnits);
        if (beforeDeadline) t.onTimeUnits = Math.max(t.onTimeUnits, observedUnits);
        const earned = Math.floor((t.xp * units) / t.target);
        assert(earned >= t.credited, 'use a separate audited correction for decreasing progress');
        const delta = earned - t.credited;
        balance += delta;
        experience += delta;
        t.credited = earned;
        t.units = units;
        record('earned', delta, id);
        if (beforeDeadline && t.penalty) {
          const nextRequested = penaltyFor(t, t.onTimeUnits);
          // No refund of a penalty that was never collected at a zero balance.
          const refund = Math.max(0, t.penalty.applied - nextRequested);
          t.penalty.requested = nextRequested;
          t.penalty.applied -= refund;
          balance += refund;
          if (refund) record('late-on-time-report-refund', refund, id);
        }
      });
    },
    settleDeadline(id, operationId) {
      return once(operationId, () => {
        const t = tasks.get(id);
        assert(t, 'unknown task');
        if (t.penalty) return;
        const requested = penaltyFor(t, t.onTimeUnits);
        const applied = Math.min(balance, requested);
        t.penalty = { requested, applied, unitsAtDeadline: t.onTimeUnits };
        balance -= applied;
        record('deadline', -applied, id);
      });
    },
    redeem(price, operationId) {
      return once(operationId, () => {
        assert(Number.isSafeInteger(price) && price > 0, 'invalid price');
        assert(price <= balance - reserve(), 'reserved XP cannot be spent');
        balance -= price;
        record('reward', -price, operationId);
      });
    },
    snapshot() {
      return {
        balance,
        experience,
        reserve: reserve(),
        available: balance - reserve(),
        tasks: [...tasks.values()],
        events: [...events],
      };
    },
  };
}

const checked = [];
assert.deepEqual(
  [0, 1, 2].flatMap((effort) => [0, 1].map((contribution) => scoreTask(effort, contribution))),
  [10, 20, 20, 35, 35, 50],
);
checked.push('task scoring uses a transparent six-cell matrix');
const sql = { id: 'sql', xp: 35, target: 5 };
const a = createModel(100, [sql]);
a.report('sql', 3, true, 'progress-1');
assert.equal(a.snapshot().balance, 121);
assert.equal(a.snapshot().reserve, 5);
assert.equal(a.snapshot().tasks[0].penalty, null);
a.settleDeadline('sql', 'deadline-1');
assert.equal(a.snapshot().balance, 116);
a.settleDeadline('sql', 'deadline-1');
a.settleDeadline('sql', 'another-cron');
assert.equal(a.snapshot().balance, 116);
a.report('sql', 5, false, 'late-result');
a.report('sql', 5, false, 'duplicate-report-with-new-id');
assert.equal(a.snapshot().balance, 130);
assert.equal(a.snapshot().experience, 35);
assert.equal(a.snapshot().tasks[0].penalty.applied, 5);
checked.push(
  'partial progress is not a failure',
  'one penalty per deadline',
  'late completion keeps its penalty',
  'result budget cannot be credited twice',
);

const b = createModel(100, [sql]);
b.settleDeadline('sql', 'deadline');
b.report('sql', 5, true, 'late-reported-on-time');
assert.equal(b.snapshot().balance, 135);
assert.equal(b.snapshot().tasks[0].penalty.applied, 0);
checked.push('late reporting of an on-time result reverses the collected loss');

const c = createModel(0, [
  { id: 'a', xp: 50, target: 1 },
  { id: 'b', xp: 20, target: 1 },
]);
c.settleDeadline('a', 'empty-balance');
c.report('b', 1, true, 'return-to-action');
assert.equal(c.snapshot().balance, 20);
assert.equal(c.snapshot().tasks[0].penalty.applied, 0);
checked.push('uncollected loss is never charged against future earnings');

const d = createModel(20, [
  { id: 'a', xp: 50, target: 1 },
  { id: 'b', xp: 20, target: 1 },
]);
assert.equal(d.snapshot().available, 0);
assert.throws(() => d.redeem(1, 'too-early'));
d.report('b', 1, true, 'b-done');
assert.equal(d.snapshot().available, 25);
d.redeem(25, 'one-coupon');
d.redeem(25, 'one-coupon');
assert.equal(d.snapshot().balance, 15);
assert.throws(() => d.redeem(1, 'second-coupon'));
checked.push('pending risks are reserved', 'reward retries do not spend twice');

const e = createModel(5, [{ id: 'a', xp: 50, target: 1 }]);
e.settleDeadline('a', 'deadline');
e.report('a', 1, true, 'late-proof');
assert.equal(e.snapshot().balance, 55);
checked.push('correction cannot refund an uncollected penalty');

const allStrict = createModel(200, [
  { id: 'a', xp: 35, target: 1 },
  { id: 'b', xp: 35, target: 1 },
  { id: 'c', xp: 20, target: 1 },
  { id: 'd', xp: 10, target: 1 },
]);
for (const id of ['a', 'b', 'c', 'd']) allStrict.settleDeadline(id, 'deadline-' + id);
assert.equal(allStrict.snapshot().balance, 169);
checked.push('every accepted task has its own penalty in the proposed strict mode');

const lateBeforeCron = createModel(100, [sql]);
lateBeforeCron.report('sql', 5, false, 'late-result-before-cron');
assert.equal(lateBeforeCron.snapshot().reserve, 11);
lateBeforeCron.settleDeadline('sql', 'delayed-cron');
assert.equal(lateBeforeCron.snapshot().balance, 124);
lateBeforeCron.report('sql', 3, true, 'older-on-time-observation');
assert.equal(lateBeforeCron.snapshot().balance, 130);
assert.equal(lateBeforeCron.snapshot().experience, 35);
checked.push(
  'late work before a delayed scheduler still has a deadline consequence',
  'older on-time observations can correct loss without duplicating result XP',
);

console.log(
  JSON.stringify(
    {
      notice:
        'Design arithmetic and state checks only; no production writes or measured motivational effect.',
      checked,
      example: {
        opening: 100,
        afterPartial: 121,
        afterDeadline: 116,
        afterLateCompletion: 130,
        totalExperience: 35,
        retainedLoss: 5,
      },
      strictFourMissedTasks: { rewards: [35, 35, 20, 10], requestedLoss: 31, appliedLoss: 31 },
    },
    null,
    2,
  ),
);
