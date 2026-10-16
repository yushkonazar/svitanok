import {
  emptyPlan,
  applyPlanCommand,
  planView,
  type PlanState,
} from '../../../core/motivation/model.mjs';
import { planWorkspaceSchema, type PlanCommand, type PlanWorkspace } from './plan.ts';

const storageKey = 'svitanok:plan-demo:v1';
let state: PlanState | undefined,
  events: Record<string, unknown>[] = [];
function load() {
  if (state) return state;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved) {
      planWorkspaceSchema.parse(planView(saved.state, Date.now(), saved.events));
      state = saved.state;
      events = saved.events;
    }
  } catch {
    /* a corrupt demo never touches owner data */
  }
  return (state ??= emptyPlan());
}
export function readPlanDemo(): PlanWorkspace {
  return planWorkspaceSchema.parse(planView(load(), Date.now(), events));
}
export function changePlanDemo(command: PlanCommand) {
  const previous = load();
  if (command.revision !== previous.revision)
    throw new Error('Демо-план уже змінився. Онови його.');
  const next = applyPlanCommand(previous, command, Date.now());
  state = next.state;
  events = [...next.events.reverse(), ...events].slice(0, 300);
  try {
    localStorage.setItem(storageKey, JSON.stringify({ state, events }));
  } catch {
    /* session still works */
  }
  return { receipt: next.receipt, workspace: readPlanDemo() };
}
export function resetPlanDemo() {
  state = undefined;
  events = [];
  localStorage.removeItem(storageKey);
}
