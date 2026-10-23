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
    id: 'airbnb',
    name: 'Airbnb',
    status: 'search_redirect',
    billing: 'none',
    documentation: 'https://www.airbnb.com/help/article/3418',
  },
  {
    id: 'infobus',
    name: 'INFOBUS / BusSystem',
    status: 'partner_access_required',
    billing: 'partner_contract',
    documentation: 'https://bussystem.eu/uk/agents',
  },
  {
    id: 'flixbus',
    name: 'FlixBus API',
    status: 'partner_access_required',
    billing: 'partner_contract',
    documentation: 'https://www.flixbus.com/company/partners/affiliate-partners',
  },
];
export const TRIP_SEARCH_MAX = 12;
/** @param {Env} env */
export function tripSearchProviders(env) {
  return TRIP_SEARCH_PROVIDERS.map((provider) => ({
    ...provider,
    status:
      provider.id === 'booking' &&
      env.BOOKING_API_TOKEN &&
      env.BOOKING_AFFILIATE_ID &&
      env.BOOKING_BOOKER_COUNTRY
        ? env.BOOKING_API_ENV === 'production'
          ? 'available'
          : 'sandbox'
        : provider.status,
  }));
}

/** Validate the common adapter result before any offer is visible or stored. Web pages cannot
 * claim a live provider quote; only a future authenticated partner adapter can do that.
 * @param {any} output @param {string} kind @param {number} nowMs @param {boolean} [authenticatedQuote] */
export function normalizeTripSearchResult(output, kind, nowMs, authenticatedQuote = false) {
  if (
    !output ||
    !Array.isArray(output.options) ||
    output.options.length > TRIP_SEARCH_MAX ||
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
      authenticatedQuote,
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
