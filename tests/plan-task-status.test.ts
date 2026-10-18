import { describe, expect, it } from 'vitest';
import { planTaskState, PLAN_TASK_STATES } from '../web/core/motivation/status.mjs';
const due = Date.parse('2026-10-18T04:30:00Z');
const task = {
  status: 'accepted',
  target: 1,
  dueAt: new Date(due).toISOString(),
  startAt: new Date(due - 1800000).toISOString(),
  facts: { units: 0, onTimeUnits: 0, done: false },
};
describe('execution states independent of report grace', () => {
  it.each([
    ['draft', { status: 'draft' }, due],
    ['scheduled', {}, due - 1800001],
    ['ready', {}, due - 1800000],
    ['in-progress', { startedAt: new Date(due - 5000).toISOString() }, due - 1],
    ['in-progress', { facts: { units: 1, onTimeUnits: 1, done: false }, target: 2 }, due - 1],
    ['completed', { facts: { units: 1, onTimeUnits: 1, done: true } }, due],
    ['completed-late', { facts: { units: 1, onTimeUnits: 0, done: true } }, due + 1],
    ['missed', {}, due],
    ['missed', { startedAt: new Date(due - 5000).toISOString() }, due + 1],
    ['missed', { forfeitedAt: new Date(due - 5000).toISOString() }, due - 1],
    ['excepted', { status: 'excepted' }, due + 1],
  ])('%s at the exact execution boundary', (state, over, now) => {
    expect(planTaskState({ ...task, ...over }, now)).toBe(state);
    expect(PLAN_TASK_STATES[state as keyof typeof PLAN_TASK_STATES]).toBeTruthy();
  });
});
