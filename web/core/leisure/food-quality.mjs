import { freshLeisureFoodSearch, freshLeisurePlace } from './google-details.mjs';
import { LeisureError } from './model.mjs';

/** Bounded, authenticated read. The caller owns the transient workspace.
 * @param {Env} env @param {any} workspace @param {any} input @param {number} [nowMs] @param {number} [maxSearches] */
export async function readLeisureFoodQuality(
  env,
  workspace,
  input = {},
  nowMs = Date.now(),
  maxSearches = 3,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new LeisureError('Перевір параметри оцінювання закладів.');
  const items = workspace.items.filter(
    (/** @type {any} */ i) => i.category === 'food' && i.placeId,
  );
  const byPlace = new Map(items.map((/** @type {any} */ i) => [i.placeId, i]));
  const byId = new Map(items.map((/** @type {any} */ i) => [i.id, i]));
  const ids = input.ids;
  if (
    ids != null &&
    (!Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 4 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !byId.has(id)))
  )
    throw new LeisureError('Обери до чотирьох закладів із каталогу для перевірки.');
  const extended =
    input.parking === true || (workspace.settings.selection?.parking ?? 'any') !== 'any';
  if (!items.length)
    return {
      checkedAt: new Date(nowMs).toISOString(),
      entries: [],
      catalogTotal: 0,
      partial: false,
      scope: 'verified-catalogue-pool',
    };
  const tasks = ids
    ? ids.map((/** @type {string} */ id) => {
        const item = /** @type {any} */ (byId.get(id));
        return freshLeisurePlace(env, item.placeId, nowMs, extended).then((place) => [place]);
      })
    : ['ресторани', 'кав’ярні', 'бари']
        .slice(0, maxSearches)
        .map((query) =>
          freshLeisureFoodSearch(env, query, workspace.settings.city, nowMs, extended),
        );
  const results = await Promise.allSettled(tasks);
  const matched = new Map();
  for (const result of results)
    if (result.status === 'fulfilled')
      for (const place of result.value) {
        const item = /** @type {any} */ (byPlace.get(place.place_id));
        if (item) matched.set(item.id, { itemId: item.id, place });
      }
  if (results.every((r) => r.status === 'rejected'))
    throw new LeisureError(
      'Не вдалося перевірити оцінки Google. Список і твої позначки збережені; спробуй ще раз.',
      503,
    );
  return {
    checkedAt: new Date(nowMs).toISOString(),
    entries: [...matched.values()],
    catalogTotal: items.length,
    partial: results.some((r) => r.status === 'rejected'),
    scope: 'verified-catalogue-pool',
  };
}
