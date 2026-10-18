export type PlanTaskState =
  | 'draft'
  | 'scheduled'
  | 'ready'
  | 'in-progress'
  | 'completed'
  | 'completed-late'
  | 'missed'
  | 'excepted';
export function planTaskState(
  task: {
    status: string;
    target: number;
    facts: { onTimeUnits: number; units: number; done: boolean };
    dueAt: string;
    startAt?: string | null;
    startedAt?: string | null;
    forfeitedAt?: string | null;
  },
  nowMs: number,
): PlanTaskState;
export const PLAN_TASK_STATES: Record<PlanTaskState, string>;
