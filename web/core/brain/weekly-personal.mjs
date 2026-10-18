import { buildCheckinPeriod } from '../tools/checkin-period.mjs';
import { weekBounds } from '../tools/weekly.mjs';
import { reportPeriod, shiftReportCutoff } from '../report-period.mjs';
import { kyivParts, shiftDate } from '../finance/planning.mjs';

/** Period metrics, not rolling context windows. Missing legacy timestamps on
 * the unfinished last day are explicitly excluded, never guessed from a slot.
 * @param {Record<string, any>} checkins @param {number} asOfMs */
export function weeklyPersonalPeriods(checkins, asOfMs) {
  const today = kyivParts(asOfMs).date;
  const from = weekBounds(today).from;
  const days = (Date.parse(today) - Date.parse(from)) / 86_400_000 + 1;
  const read = (/** @type {number} */ offset) => {
    const cutoff = shiftReportCutoff(asOfMs, -7 * offset);
    const dateFrom = shiftDate(from, -7 * offset),
      dateTo = shiftDate(today, -7 * offset);
    /** @type {Record<string, any>} */ const selected = {};
    let unknownTimingSlots = 0;
    for (const [date, record] of Object.entries(checkins ?? {})) {
      if (date < dateFrom || date > dateTo || !record || typeof record !== 'object') continue;
      const copy = { ...record };
      for (const slot of ['morning', 'afternoon', 'evening']) {
        const answer = copy[slot];
        if (!answer || typeof answer !== 'object') continue;
        const at = Date.parse(
          answer.confirmedAtV3 ??
            answer.confirmedAtV2 ??
            answer.answeredAtV3 ??
            answer.answeredAtV2 ??
            answer.ts ??
            '',
        );
        if (Number.isFinite(at) && at > cutoff) delete copy[slot];
        else if (date === dateTo && !Number.isFinite(at)) {
          unknownTimingSlots++;
          delete copy[slot];
        }
      }
      if (
        ['morning', 'afternoon', 'evening'].some(
          (slot) => copy[slot] && Object.keys(copy[slot]).length,
        )
      )
        selected[date] = copy;
    }
    const metrics = buildCheckinPeriod(selected, dateTo, days);
    return {
      period: reportPeriod(dateFrom, dateTo, cutoff),
      legacy: metrics.current,
      observationsV2: metrics.observationsV2.currentMetrics,
      observationsV3: metrics.observationsV3.currentMetrics,
      unknownTimingSlots,
    };
  };
  return {
    current: read(0),
    previousWeeks: [1, 2, 3, 4].map(read),
    rule: 'Порівнюй ці однакові календарні відрізки. Шкали legacy/v2/v3 окремі. Інші вікна дайджесту — лише контекст; відсутні відповіді не є нулями.',
  };
}
