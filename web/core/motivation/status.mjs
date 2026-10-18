/** Execution state is independent of the reporting/XP settlement window.
 * Derive it from the clock; never invent a zero report or change accepted terms.
 * @param {any} task @param {number} nowMs */
export function planTaskState(task, nowMs) {
  if (task.status === 'draft') return 'draft';
  if (task.facts.onTimeUnits >= task.target) return 'completed';
  if (task.facts.done) return 'completed-late';
  if (task.status === 'excepted') return 'excepted';
  if (task.forfeitedAt || Date.parse(task.dueAt) <= nowMs) return 'missed';
  if (task.startedAt || task.facts.units > 0) return 'in-progress';
  if (task.startAt && Date.parse(task.startAt) > nowMs) return 'scheduled';
  return 'ready';
}
export const PLAN_TASK_STATES = {
  draft: 'Чернетка',
  scheduled: 'Заплановано',
  ready: 'Очікує виконання',
  'in-progress': 'У процесі',
  completed: 'Виконано вчасно',
  'completed-late': 'Виконано із запізненням',
  missed: 'Не виконано вчасно',
  excepted: 'Не виконано · виняток',
};
