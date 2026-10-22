import { leisureDecisionIndex, leisureIdentity, leisureReactionHidden } from './identity.mjs';
import { LEISURE_EVENT_FORMATS, LEISURE_FORMAT_CATEGORIES } from './taxonomy.mjs';

export const DEFAULT_LEISURE_SELECTION = {
  minFoodRating: 4.4,
  parking: 'any',
  weeklyLimit: 12,
  formatFrequency: { opera: 'rare' },
  followedPodcastSeries: [],
  categoryOverrides: {},
};
export const LEISURE_FREQUENCIES = {
  often: 'Часто',
  sometimes: 'Іноді',
  rare: 'Зрідка',
  manual: 'За моїм запитом',
};

/** Only owner settings are persisted; live Google facts never enter this object.
 * @param {any} input @param {any} [previous] */
export function normalizeLeisureSelection(input, previous = DEFAULT_LEISURE_SELECTION) {
  const value = { ...DEFAULT_LEISURE_SELECTION, ...previous, ...input };
  if (![4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5].includes(value.minFoodRating))
    throw new Error('Обери мінімальну оцінку закладу від 4,0 до 5,0.');
  if (!['any', 'preferred', 'required'].includes(value.parking))
    throw new Error('Перевір побажання до паркування.');
  if (!Number.isInteger(value.weeklyLimit) || value.weeklyLimit < 4 || value.weeklyLimit > 12)
    throw new Error('Обери від 4 до 12 нових ідей на тиждень.');
  const frequency = {
    ...DEFAULT_LEISURE_SELECTION.formatFrequency,
    ...previous?.formatFrequency,
    ...input?.formatFrequency,
  };
  if (
    Object.entries(frequency).some(
      ([key, v]) =>
        !Object.hasOwn(LEISURE_EVENT_FORMATS, key) ||
        !Object.hasOwn(LEISURE_FREQUENCIES, String(v)),
    )
  )
    throw new Error('Перевір частоту рекомендацій.');
  if (
    !Array.isArray(value.followedPodcastSeries) ||
    value.followedPodcastSeries.length > 40 ||
    value.followedPodcastSeries.some(
      (/** @type {any} */ name) => typeof name !== 'string' || !name.trim() || name.length > 180,
    )
  )
    throw new Error('Перевір підписки на подкасти.');
  const overrides = { ...previous?.categoryOverrides, ...input?.categoryOverrides };
  if (
    Object.keys(overrides).length > 500 ||
    Object.entries(overrides).some(
      ([id, /** @type {any} */ row]) =>
        id.length > 150 ||
        !row ||
        !Object.hasOwn(LEISURE_FORMAT_CATEGORIES, row.eventFormat) ||
        LEISURE_FORMAT_CATEGORIES[row.eventFormat] !== row.category,
    )
  )
    throw new Error('Перевір уточнення типу події.');
  return {
    ...value,
    formatFrequency: frequency,
    followedPodcastSeries: [...new Set(value.followedPodcastSeries)],
    categoryOverrides: overrides,
  };
}

/** Rating confidence is a ranking aid, never a guarantee of quality.
 * @param {any} item @param {any} [preferences] @param {any} [decision] @param {string} [transport] */
export function leisureFoodQuality(
  item,
  preferences = DEFAULT_LEISURE_SELECTION,
  decision = {},
  transport = 'car',
) {
  const details = item.placeDetails ?? {};
  const rating =
    typeof details.rating === 'number' && details.rating >= 0 && details.rating <= 5
      ? details.rating
      : null;
  const count =
    Number.isInteger(details.userRatingCount) && details.userRatingCount >= 0
      ? details.userRatingCount
      : null;
  const parking = details.parking ?? {};
  const values = Object.values(parking);
  const parkingKeys = [
    'freeParkingLot',
    'paidParkingLot',
    'freeStreetParking',
    'paidStreetParking',
    'valetParking',
    'freeGarageParking',
    'paidGarageParking',
  ];
  const hasParking = values.some((v) => v === true)
    ? true
    : parkingKeys.every((key) => parking[key] === false)
      ? false
      : null;
  const priority = decision.verdict === 'interested' && decision.interestLevel === 'priority';
  const reasons = [];
  let eligible = true;
  if (['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY'].includes(details.businessStatus)) {
    eligible = false;
    reasons.push('Заклад зараз зачинений');
  }
  if (rating == null) {
    eligible = eligible && priority;
    reasons.push('Оцінку Google ще не перевірено');
  } else if (rating < (preferences.minFoodRating ?? 4.4)) {
    eligible = eligible && priority;
    reasons.push(priority ? 'Твій пріоритет нижче обраного порога' : 'Нижче обраної оцінки');
  }
  if (transport === 'car' && preferences.parking === 'required' && hasParking !== true) {
    eligible = false;
    reasons.push(
      hasParking === false
        ? 'Паркування не підтверджено як доступне'
        : 'Паркування ще не перевірено',
    );
  }
  const confidenceRating =
    rating == null ? 0 : ((count ?? 0) * rating + 70 * 4.4) / ((count ?? 0) + 70);
  const score =
    (rating == null ? 0 : (confidenceRating - 4) * 100) +
    (priority ? 60 : 0) +
    (transport === 'car' && preferences.parking === 'preferred' && hasParking === true ? 3 : 0);
  return {
    rating,
    count,
    hasParking,
    eligible,
    priority,
    verified: rating != null,
    score,
    reasons,
  };
}

/** @param {any} item */
export function leisureWorkKey(item) {
  if (item.category === 'show')
    return (
      'production:' +
      String(item.sourceUrl ?? item.source ?? item.id).split(/[?#]/)[0] +
      ':' +
      String(item.title ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase('uk')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
    );
  return item.identityKey ?? leisureIdentity(item);
}

/** Rare is a cadence preference, not a negative taste signal. Explicit wishes win.
 * @param {any} item @param {any[]} records @param {any} settings @param {number} nowMs @param {boolean} [explicit] */
export function leisureFormatAvailable(item, records, settings, nowMs, explicit = false) {
  if (explicit) return true;
  const frequency =
    settings?.selection?.formatFrequency?.[item.eventFormat] ??
    (item.eventFormat === 'opera' ? 'rare' : 'sometimes');
  if (frequency === 'manual') return false;
  if (frequency !== 'rare') return true;
  const cutoff = nowMs - 90 * 86400000;
  return !records.some(
    (r) =>
      r.kind === 'visit' &&
      r.eventFormat === item.eventFormat &&
      r.visitedOn &&
      Date.parse(r.visitedOn + 'T12:00Z') >= cutoff,
  );
}

/** One finite set for the home screen. The full catalogue remains browseable.
 * @param {any[]} items @param {any[]} records @param {any} settings @param {number} nowMs */
export function selectLeisureHighlights(items, records, settings, nowMs) {
  const decisions = leisureDecisionIndex(items, records);
  const visited = new Set(
    records
      .filter((r) => r.kind === 'visit' || (r.kind === 'familiarity' && !r.cleared))
      .map((r) => r.itemId),
  );
  const seen = new Set(),
    formats = new Map(),
    sources = new Map(),
    categories = new Map();
  const result = [];
  const limit = settings?.selection?.weeklyLimit ?? 12;
  for (const item of items) {
    if (
      item.category === 'food' ||
      (settings?.categories && !settings.categories.includes(item.category)) ||
      visited.has(item.id) ||
      ['cancelled', 'sold-out', 'postponed'].includes(item.status)
    )
      continue;
    const reaction = decisions.get(item.identityKey ?? leisureIdentity(item)) ?? {};
    if (
      reaction.verdict === 'interested' ||
      leisureReactionHidden(reaction, nowMs) ||
      !leisureFormatAvailable(item, records, settings, nowMs)
    )
      continue;
    const work = leisureWorkKey(item);
    if (seen.has(work)) continue;
    const format = item.eventFormat ?? item.category;
    const frequency =
      settings?.selection?.formatFrequency?.[format] ?? (format === 'opera' ? 'rare' : 'sometimes');
    if ((formats.get(format) ?? 0) >= (frequency === 'rare' ? 1 : frequency === 'often' ? 4 : 3))
      continue;
    if ((sources.get(item.source) ?? 0) >= 3 || (categories.get(item.category) ?? 0) >= 3) continue;
    seen.add(work);
    formats.set(format, (formats.get(format) ?? 0) + 1);
    sources.set(item.source, (sources.get(item.source) ?? 0) + 1);
    categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}
