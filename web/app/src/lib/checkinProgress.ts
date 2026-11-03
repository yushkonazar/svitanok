import type { Stats, CheckinSlot } from '../api/schema.ts';
import type { StatsResult } from '../api/client.ts';
import { kyivParts } from '../../../core/finance/planning.mjs';

export const CHECKIN_DAY_SLOTS: CheckinSlot[] = ['morning', 'afternoon', 'evening'];
export const CHECKIN_SLOT_NAMES = { morning: 'Ранок', afternoon: 'День', evening: 'Вечір' };
export type PendingCheckin = { slot: CheckinSlot; dateKey?: string };
export type CheckinProgressState =
  'done' | 'saving' | 'open' | 'draft' | 'upcoming' | 'closed' | 'unknown';
type ProgressStats = Pick<
  Stats,
  'checkinDate' | 'checkinSlot' | 'checkinToday' | 'checkinRaw' | 'checkinWindows'
>;

/** Optimistic cache writes must not restart the server clock. */
export function checkinServerNow(
  snapshot: StatsResult | undefined,
  updatedAt: number,
  now: number,
) {
  const received = snapshot?.receivedAtMs ?? updatedAt;
  const server = Date.parse(snapshot?.stats.checkinServerTime ?? '');
  return Number.isFinite(server) ? server + Math.max(0, now - received) : now;
}

export function openCheckinWindows(stats: ProgressStats, now: number) {
  return (stats.checkinWindows ?? []).filter(
    (w) => w.open && now >= Date.parse(w.startAt) && now < Date.parse(w.endAt),
  );
}

export function preferredCheckinWindow(stats: ProgressStats, now: number) {
  const open = openCheckinWindows(stats, now);
  return (
    open.find((w) => w.dateKey === stats.checkinDate && w.slot === stats.checkinSlot) ?? open[0]
  );
}

export function checkinDayRecord(stats: ProgressStats, date: string, today?: string) {
  return date === stats.checkinDate || (!stats.checkinDate && date === today)
    ? stats.checkinToday
    : stats.checkinRaw?.records[date];
}

export function checkinDayProgress(
  stats: ProgressStats,
  now: number,
  selectedDate?: string,
  pending: PendingCheckin[] = [],
) {
  const today = kyivParts(now).date;
  const preferred = preferredCheckinWindow(stats, now);
  // An open previous evening keeps its own day, including a one-time extension.
  const date =
    selectedDate ??
    preferred?.dateKey ??
    (stats.checkinDate && stats.checkinDate >= today ? stats.checkinDate : today);
  const day = checkinDayRecord(stats, date, today);
  const items = CHECKIN_DAY_SLOTS.map((slot) => {
    const answer = day?.[slot];
    const window = stats.checkinWindows?.find((w) => w.dateKey === date && w.slot === slot);
    let state: CheckinProgressState = 'unknown';
    if (pending.some((p) => p.slot === slot && (p.dateKey ?? stats.checkinDate ?? date) === date))
      state = 'saving';
    else if (answer?.confirmed === true) state = 'done';
    else if (
      window &&
      Number.isFinite(Date.parse(window.startAt)) &&
      Date.parse(window.endAt) > Date.parse(window.startAt)
    ) {
      if (now < Date.parse(window.startAt)) state = 'upcoming';
      else if (now >= Date.parse(window.endAt)) state = 'closed';
      else if (window.open)
        state = answer && Object.keys(answer).some((k) => k !== 'confirmed') ? 'draft' : 'open';
    } else if (date < today) state = 'closed';
    else if (date > today) state = 'upcoming';
    else if (!stats.checkinWindows && stats.checkinSlot) {
      const current = CHECKIN_DAY_SLOTS.indexOf(stats.checkinSlot);
      const index = CHECKIN_DAY_SLOTS.indexOf(slot);
      state = index < current ? 'closed' : index > current ? 'upcoming' : answer ? 'draft' : 'open';
    }
    const starts =
      window && Number.isFinite(Date.parse(window.startAt))
        ? new Date(window.startAt).toLocaleTimeString('uk-UA', {
            timeZone: 'Europe/Kyiv',
            hour: '2-digit',
            minute: '2-digit',
          })
        : null;
    const description = {
      done: 'Підтверджено',
      saving: 'Зберігається',
      open: 'Поточний слот',
      draft: 'Є чернетка',
      upcoming: starts ? `Від ${starts}` : 'Ще не час',
      closed: 'Не підтверджено · час минув',
      unknown: 'Статус уточнюється',
    }[state];
    return { slot, name: CHECKIN_SLOT_NAMES[slot], state, description };
  });
  const next =
    items.find((item) => ['open', 'draft'].includes(item.state) && item.slot === preferred?.slot) ??
    items.find((item) => ['open', 'draft'].includes(item.state));
  const target = next?.slot ?? preferred?.slot;
  const href = target ? `/checkin?date=${encodeURIComponent(date)}&slot=${target}` : '/checkin';
  return {
    date,
    previousDay: date < today,
    items,
    completed: items.filter((item) => item.state === 'done').length,
    href,
  };
}
export type CheckinProgress = ReturnType<typeof checkinDayProgress>;
