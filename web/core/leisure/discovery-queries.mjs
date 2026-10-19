import { leisureWeek } from './model.mjs';
const food = [
  'українська кухня',
  'італійські ресторани',
  'азійські ресторани',
  'кафе для сніданку',
  'ресторани з терасою',
  'кав’ярні з десертами',
  'грузинські ресторани',
  'вегетаріанські ресторани',
  'ресторани Підзамче',
  'кав’ярні Личаків',
  'ресторани Франківський район',
  'кав’ярні Сихів',
  'невеликі ресторани',
  'пекарні та кав’ярні',
  'ресторани Галицький район',
  'кав’ярні Залізничний район',
];
/** Eight bounded searches with rotating geography and experiences.
 * @param {any} settings @param {any} profile @param {number} nowMs */
export function leisureDiscoveryQueries(settings, profile, nowMs) {
  const week = Math.floor(Date.parse(leisureWeek(nowMs) + 'T12:00Z') / (7 * 86400000));
  const city = settings.city ?? 'Львів',
    queries = [];
  if (settings.categories.includes('food')) {
    const cuisines = /** @type {Record<string,string>} */ ({
      italian: 'італійські ресторани',
      japanese: 'японські ресторани',
      chinese: 'китайські ресторани',
      ukrainian: 'українська кухня',
      georgian: 'грузинські ресторани',
      vegetarian: 'вегетаріанські ресторани',
      vegan: 'веганські заклади',
      pizza: 'піцерії',
      seafood: 'ресторани морепродуктів',
    });
    const favoriteCuisine = (profile?.interests ?? []).find(
      (/** @type {any} */ p) =>
        p.score > 0 && p.feature?.startsWith('cuisine:') && cuisines[p.feature.slice(8)],
    );
    const preferCafe = (profile?.interests ?? []).some(
      (/** @type {any} */ p) => p.feature === 'format:cafe' && p.score > 0,
    );
    for (let n = 0; n < 3; n++)
      queries.push({ category: 'food', query: food[(week * 3 + n) % food.length] + ' ' + city });
    queries.push({
      category: 'food',
      query:
        (favoriteCuisine
          ? cuisines[favoriteCuisine.feature.slice(8)]
          : preferCafe
            ? 'атмосферні кав’ярні'
            : 'ресторани для вечері') +
        ' ' +
        city,
    });
    // Keep one query for active experiences, rather than letting food occupy most discovery.
  }
  if (settings.categories.includes('place')) {
    queries.push({ category: 'place', query: 'музеї ' + city });
    queries.push({
      category: 'place',
      query:
        [
          'океанаріум та інтерактивні музеї',
          'галереї та цікаві атракції',
          'ботанічні сади та оранжереї',
          'історичні музеї',
        ][week % 4] +
        ' ' +
        city,
    });
  }
  if (settings.categories.includes('trip'))
    queries.push({
      category: 'trip',
      query:
        (week % 2 ? 'парки й ботанічні сади' : 'оглядові майданчики та прогулянки') + ' ' + city,
    });
  if (settings.categories.includes('place'))
    queries.push({
      category: 'place',
      query:
        [
          'керамічні студії для дорослих',
          'настільні ігри та ігрові простори',
          'творчі майстерні для двох',
          'скеледром та активний відпочинок',
        ][week % 4] +
        ' ' +
        city,
    });
  return queries.slice(0, 8);
}

/** Stable local bounds eliminate the requester's IP bias. Nearby trips use a separate query.
 * @param {string} city */
export function leisureDiscoveryBounds(city) {
  return /^(?:львів|lviv)$/i.test(String(city).trim())
    ? { south: 49.72, west: 23.82, north: 49.96, east: 24.2 }
    : undefined;
}
/** @param {any} place @param {string} requested */
export function leisureDiscoveredCategory(place, requested) {
  if (place.business_status === 'CLOSED_PERMANENTLY') return null;
  const type = place.place_type ?? '';
  const food = /restaurant|cafe|coffee_shop|bakery|bar$|tea_house|food_court/.test(type);
  if (requested === 'food') return food || !type ? 'food' : null;
  if (food) return null;
  if (
    /lodging|hotel|school|university|hospital|grocery|supermarket|shopping_mall|car_dealer/.test(
      type,
    )
  )
    return null;
  return requested;
}
