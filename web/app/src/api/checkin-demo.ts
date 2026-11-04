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
export async function writeCheckinDemo(payload: Record<string, unknown>) {
  const slot = payload.slot;
  if (slot !== 'morning' && slot !== 'afternoon' && slot !== 'evening') return;
  const date = kyivParts(Date.now()).date;
  if (payload.dateKey && payload.dateKey !== date) return;
  if (payload.confirmed !== true) return;
  const prior = readCheckinDemo(date);
  if (prior[slot]?.confirmed) return;
  let candidate = payload;
  if ([3, 4].includes(Number(payload.questionVersion))) {
    // This catalog is only needed for an explicit demo confirmation. Keep it
    // out of the initial client bundle used by Today, News and private APIs.
    const [{ adaptiveModel }, { currentPlanV4, nextSleepDateV4, choiceSnapshotV4 }] =
      await Promise.all([
        import('../../../core/checkin/model.mjs'),
        import('../../../core/checkin/adaptive-v4.mjs'),
      ]);
    let choices: unknown;
    try {
      choices = JSON.parse(localStorage.getItem('svitanok:demo-settings:v1') ?? '{}').settings
        ?.checkinChoices;
    } catch {
      /* Default catalog. */
    }
    const model = adaptiveModel(payload, choices),
      context = model.context({ [date]: prior }, date, slot);
    const answers = model.clearHidden(slot, model.clean(slot, payload).set, context);
    if (!model.complete(slot, answers))
      throw new Error('Заповни основні відповіді перед підтвердженням.');
    const at = new Date().toISOString();
    candidate = {
      ...answers,
      confirmed: true,
      answeredAtV3: at,
      confirmedAtV3: at,
      timezoneV3: 'Europe/Kyiv',
    };
    if (answers.questionVersion === 4) {
      const plan = currentPlanV4(context);
      Object.assign(candidate, {
        ...choiceSnapshotV4(slot, answers, context),
        planSourceV4: plan.source,
        planTextV4: plan.text,
        planAtV4: plan.at,
        ...(slot === 'evening'
          ? { bedtimeDateV4: nextSleepDateV4(Date.now(), answers.bedtimePlanV4) }
          : {}),
      });
    }
  }
  const value = schemas[slot].safeParse(candidate);
  if (!value.success || !value.data.confirmed) return;
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
