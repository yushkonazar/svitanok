import { planLocalTime } from '../../../../core/motivation/model.mjs';
import { normalizePlanClock } from './PlanLocalTime.tsx';

export function taskEditorIso(value: string, label: string) {
  const [date, clock] = value.split('T');
  if (!date || !clock) throw new Error(`Укажи дату й час: ${label}.`);
  try {
    return planLocalTime(date, normalizePlanClock(clock));
  } catch (cause) {
    throw new Error(`${label}: ${(cause as Error).message}`, { cause });
  }
}
export function moveTaskClock(value: string, from: string, to: string) {
  if (!value || !from || !to) return value;
  const delta = Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`);
  const date = new Date(Date.parse(`${value.slice(0, 10)}T12:00:00Z`) + delta);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10) + value.slice(10)
    : value;
}
const key = (id: string) => 'svitanok:plan:task-draft:v1:' + id;
export function readTaskEditorDraft(id: string) {
  try {
    const draft = JSON.parse(localStorage.getItem(key(id)) ?? 'null');
    return draft &&
      draft.version === 1 &&
      typeof draft.title === 'string' &&
      typeof draft.criterion === 'string'
      ? draft
      : null;
  } catch {
    return null;
  }
}
export function saveTaskEditorDraft(id: string, draft: Record<string, unknown>) {
  try {
    if (!draft.title && !draft.criterion && !draft.assistantText) localStorage.removeItem(key(id));
    else localStorage.setItem(key(id), JSON.stringify({ ...draft, version: 1 }));
  } catch {
    /* The open form retains the owner's text. */
  }
}
export function clearTaskEditorDraft(id: string) {
  try {
    localStorage.removeItem(key(id));
  } catch {
    /* Already saved on the server. */
  }
}
