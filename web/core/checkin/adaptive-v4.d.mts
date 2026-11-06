import type { Field, Card, CheckinPreferences } from './catalog.mjs';
export const ACTIVITY_OPTIONS_V4: [string, string | number][];
export const DEVELOPMENT_OPTIONS_V4: [string, string | number][];
export const DIRECTION_LABELS_V4: Record<string, string>;
export const MOOD_OPTIONS_V4: [string, string | number][];
export const TIME_RANGES_V4: [string, string | number][];
export const CHECKIN_CARDS_V4: Record<'morning' | 'afternoon' | 'evening', Card[]>;
export const FOLLOWUP_CARDS_V4: Card[];
export interface AdaptiveContext {
  choices?: unknown;
  morning: Record<string, unknown>;
  afternoon?: Record<string, unknown>;
  previous: Record<string, unknown>;
  previousEvening: Record<string, unknown>;
  activities: string[];
}
export function adaptiveContextV4(
  records: Record<string, unknown>,
  date: string,
  slot: string,
): AdaptiveContext;
export function followupsV4(
  slot: string,
  a: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): Card[];
export function contextualCardV4(
  card: Card,
  answers: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): Card;
export function fieldVisibleV4(f: Field, a: Record<string, unknown>): boolean;
export function validValueV4(f: Field, v: unknown): boolean;
export function cleanCheckinV4(
  slot: string,
  a: Record<string, unknown>,
  choices?: unknown,
): { set: Record<string, unknown>; clear: string[] };
export function clearHiddenV4(
  slot: string,
  a: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): Record<string, unknown>;
export function coreCompleteV4(
  slot: string,
  a: Record<string, unknown>,
  choices?: unknown,
  context?: Partial<AdaptiveContext>,
): boolean;
export type CheckinStep = Card & { primary: string[]; followups: Card[] };
export function checkinStepsV4(
  slot: string,
  answers: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): CheckinStep[];
export function recordedCheckinStepsV4(
  slot: string,
  record: Record<string, unknown>,
): CheckinStep[];
export function checkinStepCompleteV4(card: CheckinStep, answers: Record<string, unknown>): boolean;
export function contextualFieldV4(field: Field, a: Record<string, unknown>): Field;
export function choiceSnapshotV4(
  slot: string,
  a: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): { optionLabelsV4: Record<string, Record<string, string>>; optionsRevisionV4: number };
export function answerLabelV4(f: Field, v: unknown): string;
export function adaptivePreferences(raw?: unknown): CheckinPreferences;

export function checkinGapV3(
  day: Record<string, unknown>,
  slot: string | null,
  nowMs: number,
): number;

export function eligibleFollowupsV4(
  slot: string,
  a: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): Card[];
export function plannedDirectionsV4(morning: Record<string, unknown>): string[];
export function currentPlanV4(context: Partial<AdaptiveContext>): {
  text: string;
  source: string;
  at: string | null;
};

export function nextSleepDateV4(nowMs: number, time: unknown): string | null;
