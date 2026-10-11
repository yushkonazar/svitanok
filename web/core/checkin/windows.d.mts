export type WindowSlot = 'morning' | 'afternoon' | 'evening';
export const CHECKIN_WINDOW_SLOTS: WindowSlot[];
export interface CheckinWindow {
  dateKey: string;
  slot: WindowSlot;
  key: string;
  startAt: string;
  baseEnd: string;
  endAt: string;
  extended: boolean;
}
export function checkinBoundary(date: string, minutes: number): number;
export function checkinScheduleKey(prefs?: unknown): string;
export function checkinWindow(date: string, slot: string, prefs?: unknown): CheckinWindow;
export function checkinWindowOpen(
  window: Pick<CheckinWindow, 'startAt' | 'endAt'>,
  nowMs: number,
): boolean;
export function checkinPathForStartParam(param: string): string | null;
export function checkinOpenButton(
  env: Env,
  date: string,
  slot: string,
  chatId: string | number | null,
): Record<string, unknown> | null;
