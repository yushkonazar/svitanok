import {
  checkinMorningSchema,
  checkinAfternoonSchema,
  checkinEveningSchema,
  type Stats,
} from './schema.ts';
import { kyivParts } from '../../../core/finance/planning.mjs';
const schemas = {
  morning: checkinMorningSchema,
  afternoon: checkinAfternoonSchema,
  evening: checkinEveningSchema,
};
const key = (date: string) => `svitanok:confirmed-demo-checkins:${date}`;
export function readCheckinDemo(
  date = kyivParts(Date.now()).date,
): NonNullable<Stats['checkinToday']> {
  try {
    const raw = JSON.parse(localStorage.getItem(key(date)) ?? '{}');
    const out: NonNullable<Stats['checkinToday']> = {};
    for (const slot of ['morning', 'afternoon', 'evening'] as const) {
      const value = schemas[slot].safeParse(raw?.[slot]);
      if (value.success && value.data.confirmed) Object.assign(out, { [slot]: value.data });
    }
    return out;
  } catch {
    return {};
  }
}
export function writeCheckinDemo(payload: Record<string, unknown>) {
  const slot = payload.slot;
  if (slot !== 'morning' && slot !== 'afternoon' && slot !== 'evening') return;
  const date = kyivParts(Date.now()).date;
  if (payload.dateKey && payload.dateKey !== date) return;
  const value = schemas[slot].safeParse(payload);
  if (!value.success || !value.data.confirmed) return;
  const prior = readCheckinDemo(date);
  if (prior[slot]?.confirmed) return;
  try {
    localStorage.setItem(key(date), JSON.stringify({ ...prior, [slot]: value.data }));
  } catch {
    /* React cache remains usable. */
  }
}
export function resetCheckinDemo() {
  try {
    localStorage.removeItem(key(kyivParts(Date.now()).date));
  } catch {
    /* unavailable */
  }
}
