import { normalizeTripOption } from './options.mjs';

/** Future partner adapters implement this boundary; the guided flow and storage do not depend on provider payloads.
 * @typedef {{request_id:string,kind:'transport'|'stay'|'activity',owner_answers:Record<string,unknown>,selected_reference_data:Record<string,unknown>}} TripSearchRequest
 * @typedef {{options:ReturnType<typeof normalizeTripOption>[],summary:string}} TripSearchResult
 * @typedef {{id:string,search:(request:TripSearchRequest)=>Promise<TripSearchResult>}} TripSearchAdapter
 */
export const TRIP_SEARCH_PROVIDERS = [
  { id: 'web', name: 'Пошук у мережі', status: 'available', billing: 'existing_model_usage' },
  {
    id: 'booking',
    name: 'Booking.com Demand API',
    status: 'partner_access_required',
    billing: 'partner_contract',
    documentation: 'https://developers.booking.com/demand/docs/getting-started/prerequisites',
  },
  {
    id: 'flixbus',
    name: 'FlixBus API',
    status: 'partner_access_required',
    billing: 'partner_contract',
    documentation: 'https://www.flixbus.com/company/partners/affiliate-partners',
  },
];

/** Validate the common adapter result before any offer is visible or stored. Web pages cannot
 * claim a live provider quote; only a future authenticated partner adapter can do that.
 * @param {any} output @param {string} kind @param {number} nowMs @param {boolean} [authenticatedQuote] */
export function normalizeTripSearchResult(output, kind, nowMs, authenticatedQuote = false) {
  if (
    !output ||
    !Array.isArray(output.options) ||
    output.options.length > 8 ||
    output.options.some((/** @type {any} */ o) => !o || o.kind !== kind)
  )
    throw new Error('invalid-search-result');
  const options = output.options.map((/** @type {any} */ o) =>
    normalizeTripOption(
      {
        ...o,
        availability:
          !authenticatedQuote && o.availability === 'provider_quote'
            ? 'unverified'
            : o.availability,
      },
      nowMs,
    ),
  );
  if (new Set(options.map((/** @type {any} */ o) => o.id)).size !== options.length)
    throw new Error('duplicate-options');
  return {
    options,
    summary: String(output.summary ?? '')
      .trim()
      .slice(0, 1000),
  };
}
