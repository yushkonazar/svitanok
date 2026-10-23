/** Public search redirects never imply a live quote or access to a traveller account. */
const count = (/** @type {unknown} */ n, fallback = 1) =>
  Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 100 ? Number(n) : fallback;
const date = (/** @type {unknown} */ value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : '';

/** @param {unknown} value @param {string} domain */
export function serviceUrl(value, domain) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      ? url
      : null;
  } catch {
    return null;
  }
}

/** @param {any} answers */
export function lodgingSearchTerms(answers) {
  const people = count(answers.lodging_count ?? answers.destination_count);
  const children = Math.max(0, Math.min(people - 1, Number(answers.children_count) || 0));
  return {
    destination: String(answers.to ?? '').slice(0, 120),
    checkin: date(answers.lodging_from),
    checkout: date(answers.lodging_to),
    people,
    children,
    adults: people - children,
    rooms: count(answers.lodging_rooms),
  };
}

/** Use the property's genuine Booking URL when available, otherwise search by its name.
 * @param {any} answers @param {any} [option] */
export function bookingSearchUrl(answers, option = null) {
  const terms = lodgingSearchTerms(answers);
  const direct = serviceUrl(option?.source_url, 'booking.com');
  const url =
    direct && /^\/hotel\//.test(direct.pathname)
      ? direct
      : new URL('https://www.booking.com/searchresults.html');
  if (url.pathname === '/searchresults.html')
    url.searchParams.set('ss', [option?.title, terms.destination].filter(Boolean).join(', '));
  if (terms.checkin) url.searchParams.set('checkin', terms.checkin);
  if (terms.checkout) url.searchParams.set('checkout', terms.checkout);
  url.searchParams.set('group_adults', String(terms.adults));
  url.searchParams.set('group_children', String(terms.children));
  url.searchParams.set('no_rooms', String(terms.rooms));
  if (/^[A-Z]{3}$/.test(answers.budget_currency ?? ''))
    url.searchParams.set('selected_currency', answers.budget_currency);
  return url.href;
}

/** @param {any} answers @param {any} [option] */
export function airbnbSearchUrl(answers, option = null) {
  const terms = lodgingSearchTerms(answers),
    direct = serviceUrl(option?.source_url, 'airbnb.com');
  const url =
    direct && /^\/rooms\/\d+/.test(direct.pathname)
      ? direct
      : new URL(`https://www.airbnb.com/s/${encodeURIComponent(terms.destination)}/homes`);
  if (terms.checkin) url.searchParams.set('checkin', terms.checkin);
  if (terms.checkout) url.searchParams.set('checkout', terms.checkout);
  url.searchParams.set('adults', String(terms.adults));
  url.searchParams.set('children', String(terms.children));
  return url.href;
}

/** Route landing pages verified 2026-10-23. Other cities use the genuine service home,
 * rather than guessing undocumented city IDs or pretending the dates were prefilled.
 * @param {any} answers @param {string} kind @param {any} [option] */
export function tripServiceLinks(answers, kind, option = null) {
  if (kind === 'stay')
    return [
      {
        id: 'booking',
        label: 'Booking.com',
        url: bookingSearchUrl(answers, option),
        prefilled: true,
      },
      { id: 'airbnb', label: 'Airbnb', url: airbnbSearchUrl(answers, option), prefilled: true },
    ];
  if (kind !== 'transport' || !['bus', 'mixed', 'compare'].includes(answers.mode)) return [];
  const prague =
    /^(прага|prague)$/iu.test(answers.to ?? '') && /^(львів|lviv)$/iu.test(answers.from_city ?? '');
  return [
    {
      id: 'infobus',
      label: 'INFOBUS',
      url:
        serviceUrl(option?.source_url, 'infobus.eu')?.href ??
        (prague ? 'https://infobus.eu/ua/bus/route/from-lviv-to-praha' : 'https://infobus.eu/ua'),
      prefilled: false,
    },
    {
      id: 'flixbus',
      label: 'FlixBus',
      url:
        serviceUrl(option?.source_url, 'flixbus.com')?.href ??
        (prague
          ? 'https://www.flixbus.com/bus-routes/bus-lviv-prague'
          : 'https://www.flixbus.com/'),
      prefilled: false,
    },
  ];
}
