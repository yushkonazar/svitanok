import type { Field, Card, CheckinPreferences } from './catalog.mjs';
export const ACTIVITY_OPTIONS_V3: [string, string | number][];
export const COMPANY_OPTIONS_V3: [string, string | number][];
export const FACTOR_OPTIONS_V3: [string, string | number][];
export const PRIORITY_OPTIONS_V3: [string, string | number][];
export const TIME_RANGES_V3: [string, string | number][];
export const CHECKIN_CARDS_V3: Record<string, Card[]>;
export const FOLLOWUP_CARDS_V3: Card[];
export interface AdaptiveContext {
  morning: Record<string, unknown>;
  previous: Record<string, unknown>;
  previousEvening: Record<string, unknown>;
  activities: string[];
}
export function adaptiveContext(
  records: Record<string, unknown>,
  date: string,
  slot: string,
): AdaptiveContext;
export function followupsV3(
  slot: string,
  a: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): Card[];
export function fieldVisibleV3(f: Field, a: Record<string, unknown>): boolean;
export function validValueV3(f: Field, v: unknown): boolean;
export function cleanCheckinV3(
  slot: string,
  a: Record<string, unknown>,
): { set: Record<string, unknown>; clear: string[] };
export function clearHiddenV3(
  slot: string,
  a: Record<string, unknown>,
  context?: Partial<AdaptiveContext>,
): Record<string, unknown>;
export function coreCompleteV3(slot: string, a: Record<string, unknown>): boolean;
export function answerLabelV3(f: Field, v: unknown): string;
export function adaptivePreferences(raw?: unknown): CheckinPreferences;

export function checkinGapV3(
  day: Record<string, unknown>,
  slot: string | null,
  nowMs: number,
): number;
