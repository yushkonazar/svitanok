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
    for (let n = 0; n < 4; n++)
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
  }
  if (settings.categories.includes('place')) {
    queries.push({ category: 'place', query: 'музеї ' + city });
    queries.push({
      category: 'place',
      query:
        (week % 2 ? 'океанаріум та інтерактивні музеї' : 'галереї та цікаві атракції') + ' ' + city,
    });
  }
  if (settings.categories.includes('trip'))
    queries.push({
      category: 'trip',
      query:
        (week % 2 ? 'парки й ботанічні сади' : 'оглядові майданчики та прогулянки') + ' ' + city,
    });
  return queries.slice(0, 8);
}
