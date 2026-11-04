import * as v3 from './adaptive.mjs';
import * as v4 from './adaptive-v4.mjs';
/** All consumers select the catalog by the stored revision, never by today's UI.
 * @param {KvBlob} a @param {unknown} [choices] */
export function adaptiveModel(a, choices) {
  return a?.questionVersion === 4
    ? {
        cards: v4.CHECKIN_CARDS_V4,
        details: v4.FOLLOWUP_CARDS_V4,
        clean: (/** @type {string} */ slot, /** @type {KvBlob} */ raw) =>
          v4.cleanCheckinV4(slot, raw, choices),
        clearHidden: (
          /** @type {string} */ slot,
          /** @type {KvBlob} */ raw,
          /** @type {KvBlob} */ context = {},
        ) => v4.clearHiddenV4(slot, raw, { ...context, choices }),
        complete: (/** @type {string} */ slot, /** @type {KvBlob} */ raw) =>
          v4.coreCompleteV4(slot, raw, choices),
        followups: (
          /** @type {string} */ slot,
          /** @type {KvBlob} */ raw,
          /** @type {KvBlob} */ context = {},
        ) => v4.followupsV4(slot, raw, { ...context, choices }),
        context: (
          /** @type {KvBlob} */ records,
          /** @type {string} */ date,
          /** @type {string} */ slot,
        ) => ({ ...v4.adaptiveContextV4(records, date, slot), choices }),
      }
    : {
        cards: v3.CHECKIN_CARDS_V3,
        details: v3.FOLLOWUP_CARDS_V3,
        clean: v3.cleanCheckinV3,
        clearHidden: v3.clearHiddenV3,
        complete: v3.coreCompleteV3,
        followups: v3.followupsV3,
        context: v3.adaptiveContext,
      };
}
export const adaptiveCatalog = [
  ...Object.values(v3.CHECKIN_CARDS_V3).flat(),
  ...v3.FOLLOWUP_CARDS_V3,
  ...Object.values(v4.CHECKIN_CARDS_V4).flat(),
  ...v4.FOLLOWUP_CARDS_V4,
];
