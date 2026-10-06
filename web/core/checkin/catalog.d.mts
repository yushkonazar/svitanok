export interface Field {
  id: string;
  label: string;
  type: 'one' | 'multi' | 'number' | 'duration' | 'text' | 'datetime' | 'time' | 'categories';
  options?: [string, string | number][];
  min?: number;
  max?: number;
  limit?: number;
  optional?: boolean;
  when?: { key: string; values?: unknown[]; positive?: boolean; notValues?: unknown[] };
  help?: string;
  period?: string;
}
export interface Card {
  id: string;
  title: string;
  module?: string;
  fields: Field[];
  help?: string;
}
export interface CheckinPreferences {
  version?: 3;
  modules: string[];
  schedule: { morning: string; afternoon: string; evening: string; end: string };
  habits: { id: string; name: string; days: number[] }[];
  categories: { id: string; name: string; group: string }[];
  hiddenCategories: string[];
}
export const DEFAULT_CHECKIN_PREFERENCES: CheckinPreferences;
export const CHECKIN_MODULES: [string, string][];
export const ACTIVITY_GROUPS: string[];
export const ACTIVITIES: { id: string; name: string; group: string }[];
export const CHECKIN_CARDS: Record<string, Card[]>;
export function minuteOf(value: unknown): number | null;
export function validSchedule(schedule: Record<string, unknown>): boolean;
export function normalizeCheckinPreferences(raw: unknown): CheckinPreferences;
export function checkinClock(
  minute: number,
  prefs?: unknown,
): {
  slot: 'morning' | 'afternoon' | 'evening' | null;
  endsIn: number | null;
  nextIn: number;
  previousDay: boolean;
  schedule: CheckinPreferences['schedule'];
};
export function checkinReminder(
  minute: number,
  prefs?: unknown,
): { slot: 'morning' | 'afternoon' | 'evening'; text: string } | null;
export function fieldVisible(field: Field, answers: Record<string, unknown>): boolean;
export function validFieldValue(field: Field, value: unknown): boolean;
export function cleanCheckinV2(
  slot: string,
  raw: Record<string, unknown>,
): { set: Record<string, unknown>; clear: string[] };
export function clearHiddenV2(
  slot: string,
  answers: Record<string, unknown>,
): Record<string, unknown>;
export function coreCompleteV2(slot: string, answers: Record<string, unknown>): boolean;
