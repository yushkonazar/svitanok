// Steam price checks have a daily external side effect plus a failure streak.
// These values are one state machine, not independent KV counters.
export const STEAM_CHECK_STATE_DO_NAME = 'steam-check-state';
export const STEAM_CHECK_LEASE_MS = 30 * 60_000;
export const STEAM_MARKER_KEY = 'steamCheckDay';
export const STEAM_MISS_KEY = 'steamCheckMisses';
export const STEAM_SALE_KEY = 'steamSaleShare';

/** @param {unknown} value */
function nonNegative(value) {
  return Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
}

/** @param {unknown} legacy */
export function normalizeSteamCheckState(legacy) {
  const source =
    /** @type {{marker?: unknown, completedDay?: unknown, misses?: unknown, saleShare?: unknown}|null} */ (
      legacy && typeof legacy === 'object' ? legacy : null
    );
  return {
    completedDay:
      typeof source?.completedDay === 'string'
        ? source.completedDay
        : typeof source?.marker === 'string'
          ? source.marker
          : '',
    misses: Math.floor(nonNegative(source?.misses)),
    saleShare: Math.min(1, nonNegative(source?.saleShare)),
  };
}
