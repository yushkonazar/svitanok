// Одноразовий/повторюваний генератор web/app/public/settlements.json з
// GeoNames-дампів. Запуск:
//   node web/scripts/gen-settlements.mjs <UA.txt> <cities15000.txt> <uk-alt-names.txt>
//
// <uk-alt-names.txt> — рядки isolanguage==='uk' з
// download.geonames.org/export/dump/alternateNamesV2.zip (778МБ; на диску
// лишати не варто, лише профільтрований підсумок):
//   unzip alternateNamesV2.zip alternateNamesV2.txt
//   awk -F'\t' '$3=="uk"' alternateNamesV2.txt > uk-alt-names.txt
//
// Джерело: GeoNames (CC-BY 4.0, https://www.geonames.org/).
//
// ⚠️ Українською, БЕЗ винятків (фідбек власника: «Російська — ТАБУ»).
// Перша версія цього скрипта брала «останню кириличну» назву з мішаного
// (усі мови разом, без тегів) стовпця alternatenames головного дампу —
// емпіричний здогад, що ламався мовчки: деякі записи мали ЛИШЕ російську
// альтернативу, і вона проходила як «українська». Тепер — ЛИШЕ офіційно
// тегований isolanguage==='uk' запис (перевага isPreferredName=1); немає
// такого — фолбек на латинську asciiname/name (НІКОЛИ не на іншу
// кирилицю), тож помилково показати не ту мову неможливо за конструкцією,
// не за здогадкою.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [, , uaPath, worldPath, ukAltPath] = process.argv;
if (!uaPath || !worldPath || !ukAltPath) {
  console.error('Usage: node gen-settlements.mjs <UA.txt> <cities15000.txt> <uk-alt-names.txt>');
  process.exit(1);
}

// Стандартні короткі назви областей (номінатив) — GeoNames admin1 не дає
// кирилицю, тож мапимо код -> назву власноруч (фіксований, добре відомий
// перелік, 27 записів).
const UA_OBLAST = {
  '01': 'Черкаська обл.',
  '02': 'Чернігівська обл.',
  '03': 'Чернівецька обл.',
  '04': 'Дніпропетровська обл.',
  '05': 'Донецька обл.',
  '06': 'Івано-Франківська обл.',
  '07': 'Харківська обл.',
  '08': 'Херсонська обл.',
  '09': 'Хмельницька обл.',
  10: 'Кіровоградська обл.',
  11: 'АР Крим',
  12: 'м. Київ',
  13: 'Київська обл.',
  14: 'Луганська обл.',
  15: 'Львівська обл.',
  16: 'Миколаївська обл.',
  17: 'Одеська обл.',
  18: 'Полтавська обл.',
  19: 'Рівненська обл.',
  20: 'м. Севастополь',
  21: 'Сумська обл.',
  22: 'Тернопільська обл.',
  23: 'Вінницька обл.',
  24: 'Волинська обл.',
  25: 'Закарпатська обл.',
  26: 'Запорізька обл.',
  27: 'Житомирська обл.',
};

const round3 = (n) => Math.round(n * 1000) / 1000;

/** geonameid -> офіційна українська назва (isolanguage==='uk'). Перевага
 *  isPreferredName==='1'; серед решти — перша за файлом (стабільно, без
 *  подальшого здогаду). Формат рядка (GeoNames alternate names table):
 *  alternateNameId, geonameid, isolanguage, name, isPreferred, isShort,
 *  isColloquial, isHistoric, from, to. */
function buildUkNameMap(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [, geonameid, , name, isPreferred] = line.split('\t');
    if (!geonameid || !name) continue;
    const existing = map.get(geonameid);
    if (!existing || isPreferred === '1') map.set(geonameid, name);
  }
  return map;
}

// Адмінодиниці, що завжди рахуються «містом» (обл./столиця) чи «смт»
// (районний/нижчий центр) незалежно від населення — самé статус адмінцентру
// вже сигналізує «це не хутір». Звичайні PPL додаємо лише від 3000 населення.
const UA_ADMIN_SEAT_CODES = new Set(['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5']);
const UA_MIN_PLAIN_POP = 3000;

function parseUA(text, ukNames) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    // 1 geonameid, 2 name, 3 asciiname, 5 lat, 6 lon, 7 feature class,
    // 8 feature code, 9 country, 11 admin1, 15 population
    const [geonameid, name, , , latS, lonS, , featureCode, , , admin1, , , , popS] = f;
    const population = Number(popS) || 0;
    const isAdminSeat = UA_ADMIN_SEAT_CODES.has(featureCode);
    if (!isAdminSeat && !(featureCode === 'PPL' && population >= UA_MIN_PLAIN_POP)) continue;
    const lat = Number(latS);
    const lon = Number(lonS);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      name: ukNames.get(geonameid) ?? name, // фолбек — латинська asciiname/name, НІКОЛИ інша кирилиця
      lat: round3(lat),
      lon: round3(lon),
      country: 'UA',
      region: UA_OBLAST[admin1] ?? null,
      population,
      hasUk: ukNames.has(geonameid),
    });
  }
  return out;
}

function parseWorld(text, ukNames) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const [geonameid, name, , , latS, lonS, , , country, , , , , , popS] = f;
    if (country === 'UA') continue; // Україна вже щільніше покрита parseUA
    if (country === 'RU') continue; // фідбек власника — прибрати всі російські міста
    const lat = Number(latS);
    const lon = Number(lonS);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      name: ukNames.get(geonameid) ?? name, // є укр. екзонім (Лондон, Париж…) -> береться; інакше локальна/англ. назва
      lat: round3(lat),
      lon: round3(lon),
      country,
      region: null,
      population: Number(popS) || 0,
    });
  }
  return out;
}

const ukNames = buildUkNameMap(readFileSync(ukAltPath, 'utf8'));
const ua = parseUA(readFileSync(uaPath, 'utf8'), ukNames);
const world = parseWorld(readFileSync(worldPath, 'utf8'), ukNames);

// Скільки записів УКРАЇНИ (з фактично збережених, не з усього дампу) реально
// отримали офіційну українську назву, а не латинський фолбек — контроль
// якості на кожен прогін генератора.
const uaWithUk = ua.filter((c) => c.hasUk).length;

const all = [...ua, ...world].sort((a, b) => b.population - a.population);

// Кортежі, не обʼєкти: [name, lat, lon, country, region]. population
// відкидаємо у виводі — потрібна лише для сортування, у пошуку не
// використовується (клієнт бачить лише перші N збігів по префіксу).
const rows = all.map((c) => [c.name, c.lat, c.lon, c.country, c.region]);

const outDir = new URL('../app/public/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('settlements.json', outDir), JSON.stringify(rows));

console.log(
  `UA: ${ua.length} (${uaWithUk} з офіційною укр. назвою, ${ua.length - uaWithUk} — латинський фолбек), world: ${world.length}, total: ${all.length}`,
);
