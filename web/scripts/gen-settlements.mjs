// Одноразовий/повторюваний генератор web/app/public/settlements.json з
// GeoNames-дампів (UA.txt — повний дамп Україна, cities15000.txt — великі
// міста світу). Запуск:
//   node web/scripts/gen-settlements.mjs <шлях-до-UA.txt> <шлях-до-cities15000.txt>
//
// Джерело: GeoNames (CC-BY 4.0, https://www.geonames.org/), дампи
// download.geonames.org/export/dump/{UA,cities15000}.zip.
//
// Чому JSON у web/app/public/, а не імпорт у worker.js: статичний ассет
// (Cloudflare Workers Assets) НЕ рахується в ліміт розміру Worker-скрипта,
// і, головне, дає фронту зробити пошук ЦІЛКОМ на клієнті (фідбек власника:
// «звичайна пошукова логіка» — список звужується щосимволу, БЕЗ мережевого
// запиту на кожен keystroke). Формат — компактні кортежі
// [name, lat, lon, country, region] (не об'єкти з повторюваними ключами) —
// менший файл. lat/lon округлені до 3 знаків (~110м, для міста/смт цілком
// достатньо). Відсортовано за population — лінійний префікс-фільтр на
// фронті природно бере найбільші міста першими при однаковому префіксі
// (кілька однойменних Рівне), без окремого сортування результату.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [, , uaPath, worldPath] = process.argv;
if (!uaPath || !worldPath) {
  console.error('Usage: node gen-settlements.mjs <UA.txt> <cities15000.txt>');
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

const CYRILLIC_RE = /[А-ЩЬЮЯЇІЄҐа-щьюяїієґ]/;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Українська назва з alternatenames: беремо ОСТАННІЙ кириличний варіант —
 *  емпірично (перевірено на прод-вибірці) саме він здебільшого сучасна
 *  українська назва (російська зазвичай іде РАНІШЕ в списку). */
function pickUkrainianName(altNamesRaw, fallback) {
  const alts = altNamesRaw ? altNamesRaw.split(',') : [];
  const cyr = alts.filter((a) => CYRILLIC_RE.test(a));
  return cyr.length ? cyr[cyr.length - 1] : fallback;
}

// Адмінодиниці, що завжди рахуються «містом» (обл./столиця) чи «смт»
// (районний/нижчий центр) незалежно від населення — самé статус адмінцентру
// вже сигналізує «це не хутір». Звичайні PPL додаємо лише від 3000 населення.
const UA_ADMIN_SEAT_CODES = new Set(['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5']);
const UA_MIN_PLAIN_POP = 3000;

function parseUA(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    // 1 geonameid, 2 name, 3 asciiname, 4 alternatenames, 5 lat, 6 lon,
    // 7 feature class, 8 feature code, 9 country, 11 admin1, 15 population
    const [, name, , altNames, latS, lonS, , featureCode, , , admin1, , , , popS] = f;
    const population = Number(popS) || 0;
    const isAdminSeat = UA_ADMIN_SEAT_CODES.has(featureCode);
    if (!isAdminSeat && !(featureCode === 'PPL' && population >= UA_MIN_PLAIN_POP)) continue;
    const lat = Number(latS);
    const lon = Number(lonS);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      name: pickUkrainianName(altNames, name),
      lat: round3(lat),
      lon: round3(lon),
      country: 'UA',
      region: UA_OBLAST[admin1] ?? null,
      population,
    });
  }
  return out;
}

function parseWorld(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const [, name, , , latS, lonS, , , country, , , , , , popS] = f;
    if (country === 'UA') continue; // Україна вже щільніше покрита parseUA
    const lat = Number(latS);
    const lon = Number(lonS);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      name,
      lat: round3(lat),
      lon: round3(lon),
      country,
      region: null,
      population: Number(popS) || 0,
    });
  }
  return out;
}

const ua = parseUA(readFileSync(uaPath, 'utf8'));
const world = parseWorld(readFileSync(worldPath, 'utf8'));

const all = [...ua, ...world].sort((a, b) => b.population - a.population);

// Кортежі, не обʼєкти: [name, lat, lon, country, region]. population
// відкидаємо у виводі — потрібна лише для сортування, у пошуку не
// використовується (клієнт бачить лише перші N збігів по префіксу).
const rows = all.map((c) => [c.name, c.lat, c.lon, c.country, c.region]);

const outDir = new URL('../app/public/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL('settlements.json', outDir), JSON.stringify(rows));
console.log(`UA: ${ua.length}, world: ${world.length}, total: ${all.length}`);
