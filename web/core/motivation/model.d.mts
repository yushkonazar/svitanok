// Record variants are validated at the command boundary and response schema.
export interface PlanState {
  revision: number;
  balance: number;
  experience: number;
  settings: {
    enabled: boolean;
    reviewedAt?: string | null;
    rulesVersion?: number;
    penaltyPercent: number;
    dayBoundary: string;
    reportGraceHours: number;
    eveningAt: string;
  };
  primaryRewardId: string | null;
  records: Record<string, any>;
}
export function emptyPlan(): PlanState;
export function normalizePlanSettings(settings: any): PlanState['settings'];
export function dayBoundaryAt(date: string, settings: { dayBoundary: string }): string;
export function applyPlanCommand(
  state: PlanState,
  command: { op: string; id?: string; commandId: string; payload?: Record<string, unknown> },
  nowMs: number,
): {
  state: PlanState;
  events: Record<string, unknown>[];
  receipt: { message: string; id: string; reportId: string };
};
export function planView(
  state: PlanState,
  nowMs: number,
  events?: Record<string, unknown>[],
): { today: string; tasks: any[]; events: any[]; [key: string]: any };
export function planLocalTime(date: string, clock: string): string;
export function validateTaskTiming(timing: {
  startAt: string | null;
  endAt: string | null;
  dueAt: string;
  calendar?: boolean;
}): void;
export function taskScore(effort: number, contribution: number): number;
export function personalPlanDate(settings: PlanState['settings'], nowMs: number): string;
export function currentPlanDate(state: PlanState, nowMs: number): string;
export function planDate(date: unknown): string;
export function planWallet(state: PlanState): {
  balance: number;
  experience: number;
  risk: number;
  reserved: number;
  available: number;
};
export function taskFacts(
  state: PlanState,
  task: unknown,
): {
  units: number;
  eligibleUnits: number;
  target: number;
  credited: number;
  onTimeUnits: number;
  risk: number;
  done: boolean;
};
export function planRecords(state: PlanState, kind: string): any[];
export function observedResultUnits(result: any): number;
export function taskNeedsReport(state: PlanState, task: any, nowMs: number): boolean;
export const PLAN_OPERATIONS: string[];
export const XP_BANDS: number[];
export const DEFAULT_PLAN_SETTINGS: PlanState['settings'];
export const REWARD_SUGGESTIONS: { title: string; price: number; scale: string }[];
export class PlanError extends Error {
  status: number;
  field?: string;
  constructor(message?: string, status?: number, field?: string);
}
