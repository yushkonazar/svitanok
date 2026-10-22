import { normalizeTripAnswers } from '../tools/trip.mjs';

export const PLANNING_KINDS = ['transport', 'stay', 'activity'];
/** A canonical owner brief, never generated prose. @param {any} value @returns {string} */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
/** @param {any} answers */
export const planningBriefKey = (answers) => canonical(normalizeTripAnswers(answers));
/** No nested planning keys, timestamps or generated bookkeeping in downstream context.
 * @param {any} option */
export function planningOptionReference(option) {
  return Object.fromEntries(
    [
      'id',
      'kind',
      'title',
      'provider',
      'source_url',
      'price',
      'dates',
      'schedule',
      'location',
      'cancellation',
    ].map((key) => [key, option[key] ?? null]),
  );
}
/** Downstream research includes the owner's actual upstream choices, including manual notes.
 * @param {any} answers @param {string} kind */
export function planningStageKey(answers, kind) {
  return canonical({
    brief: normalizeTripAnswers(answers),
    choices: Object.fromEntries(
      PLANNING_KINDS.slice(0, PLANNING_KINDS.indexOf(kind)).map((key) => {
        const d = answers._planning?.decisions?.[key];
        return [
          key,
          d
            ? {
                mode: d.mode,
                note: d.note,
                options: (d.options ?? []).map(planningOptionReference),
              }
            : null,
        ];
      }),
    ),
  });
}
